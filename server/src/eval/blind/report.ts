// What a person reads after a run: report.md, the blind rating sheet for native speakers, and the
// key that unblinds it. Every number in the report is computed here from outputs.jsonl, judge.jsonl
// and the ledger. None is typed in.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dialectByCode } from "@translatv/shared";
import { PROGRAMS } from "../../spend/caps.js";
import { load, totals } from "../../spend/ledger.js";
import { roundMoney } from "../../spend/pricing.js";
import { ARMS, ERROR_TAGS, JUDGE_MODEL, type ArmId } from "./arms.js";
import { rowUsd } from "./budget.js";
import { contextFor, TARGETS, type BlindItem } from "./items.js";
import { markerCheck } from "./markers.js";
import { BlindRun, type JudgeRecord, type OutputRecord } from "./runner.js";
import { mean, pairedBootstrap, percentile, rng, seedFrom, shuffled, type Interval } from "./stats.js";

/** Translations a minute the cost per call hour is projected at: one busy two person call. */
export const TRANSLATIONS_PER_MINUTE = 20;
export const BOOTSTRAP_RESAMPLES = 2000;
/** One item in this many appears twice on the rating sheet, for checking a rater's agreement. */
export const DUPLICATE_EVERY = 5;

export interface ReportInput {
  runId: string;
  seed: number;
  root: string;
  runRoom: string;
  items: readonly BlindItem[];
  selected: readonly BlindItem[];
  outputs: Map<string, OutputRecord>;
  judged: Map<string, JudgeRecord>;
  budgetUsd: number;
  judgeBudgetUsd: number;
  judgeEnabled: boolean;
  stops: readonly string[];
  disabled: Readonly<Record<string, string>>;
  dryRun: boolean;
}

// ------------------------------------------------------------------------------------------------
// Per arm figures

export interface ArmStats {
  items: number;
  ok: number;
  refusals: number;
  failures: number;
  notRun: number;
  judgedItems: number;
  meanScore: number | null;
  rightDialectRate: number | null;
  markerPass: number;
  markerFail: number;
  markerInconclusive: number;
  latencyP50: number | null;
  latencyP90: number | null;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanCostUsd: number | null;
  costPerCallHourUsd: number | null;
  errorTags: Record<string, number>;
}

function ratingFor(record: JudgeRecord | undefined, arm: ArmId) {
  if (record?.status !== "ok") return undefined;
  return record.ratings.find((r) => r.arms.includes(arm));
}

export function armStats(input: ReportInput, scope: readonly BlindItem[], arm: ArmId): ArmStats {
  const records = scope.map((item) => input.outputs.get(`${item.id}:${arm}`));
  const answered = records.filter((r): r is OutputRecord => r !== undefined && r.status !== "error");
  const ratings = scope.map((item) => ratingFor(input.judged.get(item.id), arm)).filter((r) => r !== undefined);
  const markers = scope
    .map((item) => {
      const record = input.outputs.get(`${item.id}:${arm}`);
      return record?.status === "ok" && record.text !== null ? markerCheck(item, record.text) : null;
    })
    .filter((m) => m !== null && m.applicable);
  const costs = answered.map((r) => r.cost_usd).filter((c): c is number => typeof c === "number");
  const meanCost = mean(costs);
  const errorTags: Record<string, number> = Object.fromEntries(ERROR_TAGS.map((t) => [t, 0]));
  for (const rating of ratings) for (const tag of rating.errors) errorTags[tag] = (errorTags[tag] ?? 0) + 1;
  return {
    items: scope.length,
    ok: records.filter((r) => r?.status === "ok").length,
    refusals: records.filter((r) => r?.status === "refusal").length,
    failures: records.filter((r) => r !== undefined && (r.status === "error" || r.status === "empty" || r.status === "truncated")).length,
    notRun: records.filter((r) => r === undefined).length,
    judgedItems: ratings.length,
    meanScore: mean(ratings.map((r) => r.score)),
    rightDialectRate: mean(ratings.map((r) => (r.right_dialect ? 1 : 0))),
    markerPass: markers.filter((m) => m!.outcome === "pass").length,
    markerFail: markers.filter((m) => m!.outcome === "fail").length,
    markerInconclusive: markers.filter((m) => m!.outcome === "inconclusive").length,
    latencyP50: percentile(answered.map((r) => r.latency_ms), 50),
    latencyP90: percentile(answered.map((r) => r.latency_ms), 90),
    meanInputTokens: mean(answered.map((r) => r.input_tokens ?? 0)),
    meanOutputTokens: mean(answered.map((r) => r.output_tokens ?? 0)),
    meanCostUsd: meanCost === null ? null : roundMoney(meanCost),
    costPerCallHourUsd: meanCost === null ? null : roundMoney(meanCost * TRANSLATIONS_PER_MINUTE * 60),
    errorTags,
  };
}

/** The paired difference arm minus A over the items the judge rated both on, with its interval. */
export function differenceVsA(input: ReportInput, scope: readonly BlindItem[], arm: ArmId, scopeName: string): Interval | null {
  const diffs: number[] = [];
  for (const item of scope) {
    const record = input.judged.get(item.id);
    const a = ratingFor(record, "A");
    const other = ratingFor(record, arm);
    if (a !== undefined && other !== undefined) diffs.push(other.score - a.score);
  }
  return pairedBootstrap(diffs, BOOTSTRAP_RESAMPLES, rng(seedFrom(`${input.seed}:bootstrap:${scopeName}:${arm}`)));
}

// ------------------------------------------------------------------------------------------------
// Formatting

const fixed = (value: number | null, digits: number, suffix = ""): string => (value === null ? "n/a" : `${value.toFixed(digits)}${suffix}`);
const pct = (value: number | null): string => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const usd = (value: number | null, digits = 6): string => (value === null ? "n/a" : `$${value.toFixed(digits)}`);
const interval = (value: Interval | null): string =>
  value === null ? "n/a (no paired ratings)" : `${value.mean >= 0 ? "+" : ""}${value.mean.toFixed(2)} [${value.low.toFixed(2)}, ${value.high.toFixed(2)}], n=${value.n}`;

function markerCell(s: ArmStats): string {
  const decided = s.markerPass + s.markerFail;
  if (decided === 0 && s.markerInconclusive === 0) return "n/a";
  return `${decided === 0 ? "n/a" : pct(s.markerPass / decided)} (${s.markerPass}/${decided}, ${s.markerInconclusive} inconclusive)`;
}

function armTable(input: ReportInput, scope: readonly BlindItem[]): string[] {
  const lines = [
    "| arm | translated ok | refusals | failures | not run | judged | mean score | right dialect | marker checks | p50 ms | p90 ms | in tok | out tok | cost/call | per call hour |",
    "|-----|---------------|----------|----------|---------|--------|------------|---------------|---------------|--------|--------|--------|---------|-----------|---------------|",
  ];
  for (const arm of ARMS) {
    const s = armStats(input, scope, arm.id);
    lines.push(
      `| ${arm.id} | ${s.ok}/${s.items} | ${s.refusals} | ${s.failures} | ${s.notRun} | ${s.judgedItems} | ${fixed(s.meanScore, 1)} ` +
        `| ${pct(s.rightDialectRate)} | ${markerCell(s)} | ${fixed(s.latencyP50, 0)} | ${fixed(s.latencyP90, 0)} ` +
        `| ${fixed(s.meanInputTokens, 0)} | ${fixed(s.meanOutputTokens, 0)} | ${usd(s.meanCostUsd)} | ${usd(s.costPerCallHourUsd, 2)} |`,
    );
  }
  return lines;
}

function runSpend(input: ReportInput) {
  const rows = load({ root: input.root }).filter((r) => r.program === PROGRAMS.blindTest && r.room === input.runRoom);
  const judge = rows.filter((r) => r.model === JUDGE_MODEL);
  const translate = rows.filter((r) => r.model !== JUDGE_MODEL);
  const sum = (list: typeof rows) => roundMoney(list.reduce((t, r) => t + rowUsd(r), 0));
  const lost = rows.filter((r) => typeof r.cost_usd !== "number");
  return { rows: rows.length, translateUsd: sum(translate), judgeUsd: sum(judge), totalUsd: sum(rows), lostRows: lost.length, lostUsd: sum(lost) };
}

export function renderReport(input: ReportInput): string {
  const spend = runSpend(input);
  const judgedOk = input.selected.filter((item) => input.judged.get(item.id)?.status === "ok").length;
  const judgeFailed = [...input.judged.values()].filter((r) => r.status !== "ok").length;
  const lines: string[] = [];
  lines.push(
    `# Blind translation test, run ${input.runId}${input.dryRun ? " (DRY RUN: fake client, temporary ledger, numbers mean nothing)" : ""}`,
    "",
    "Generated from outputs.jsonl, judge.jsonl and the spend ledger by `npm run blind`. Every number below is",
    "computed from those files; regenerate it by rerunning the same command with `--run-id " + input.runId + "`.",
    "",
    "## Read this first",
    "",
    `- The ${input.items.length} source lines are SYNTHETIC, written for this test (eval/blind/README.md), not real call transcripts.`,
    "  Real speech is messier: recognition errors, fragments, crosstalk.",
    "- The judge is an LLM (" + JUDGE_MODEL + "), rating blind: it was told it was rating blind, was never told the models, and saw",
    "  the candidates under the labels 1, 2, 3 in a seeded random order, identical outputs shown once and scored once. Its scores",
    "  are a PRELIMINARY signal. The real test is the human sheet, rating_sheet.csv, filled in by native speakers.",
    "- No glossary was used: the set is synthetic and has none. Production adds a room's glossary to the prompt; that path is",
    "  not measured here.",
    "- Each conversation is one person speaking, so the context lines all come from one speaker, unlike a real two person call.",
    "- Latency is measured here without production's 6 second timeout, one call at a time per worker, " +
      "from this machine. It is a comparison between arms, not a production figure.",
    `- ${judgedOk} of ${input.selected.length} items were judged${input.judgeEnabled ? "" : " (the judge was switched off for this run)"}.` +
      (judgedOk < input.selected.length ? " The judge pass rates items interleaved across the five targets, so a partial pass is a balanced sample, but a smaller one." : ""),
    `- ${judgeFailed} judge calls ended without a usable rating (refusal, truncated, invalid, or a retriable error).`,
    "- Marker checks are automatic word checks for the form of address each target asks for (src/eval/blind/markers.ts). They",
    "  run only where the item's address makes them meaningful, and a line with no deciding word is inconclusive, not a pass:",
    "  the rate is passes over decided checks.",
    "",
  );
  if (input.stops.length > 0 || Object.keys(input.disabled).length > 0) {
    lines.push("## The run stopped early", "");
    for (const stop of input.stops) lines.push(`- ${stop}`);
    for (const [name, reason] of Object.entries(input.disabled)) {
      lines.push(`- ${name === "judge" ? "The judge" : `Arm ${name}`} was switched off: ${reason}, which retrying cannot fix.`);
    }
    lines.push("");
  }
  lines.push("## Arms", "", "| arm | model | how it was asked |", "|-----|-------|------------------|");
  for (const arm of ARMS) {
    const p = arm.profile;
    const how = [
      p.temperature === null ? "no temperature" : `temperature ${p.temperature}`,
      p.thinking === "omit" ? "no thinking field" : `thinking ${p.thinking}`,
      p.effort === null ? "no effort field" : `effort ${p.effort}`,
      `max_tokens ${p.maxTokens}`,
    ].join(", ");
    lines.push(`| ${arm.id} | ${arm.model} | ${arm.label}: ${how} |`);
  }
  lines.push(
    "",
    "## Overall",
    "",
    `${input.selected.length} items. Mean score is the judge's 0 to 100. Cost per call is the ledger's, per answered call; ` +
      `per call hour projects it at ${TRANSLATIONS_PER_MINUTE} translations a minute.`,
    "",
    ...armTable(input, input.selected),
    "",
    `Paired difference in judge score against arm A, mean with a ${BOOTSTRAP_RESAMPLES} resample bootstrap 95 percent interval:`,
    "",
    `- B minus A: ${interval(differenceVsA(input, input.selected, "B", "overall"))}`,
    `- C minus A: ${interval(differenceVsA(input, input.selected, "C", "overall"))}`,
    "",
    "An interval that includes 0 means this run cannot tell the two arms apart on the judge's scores.",
    "",
  );
  for (const target of TARGETS) {
    const scope = input.selected.filter((i) => i.tgt === target);
    if (scope.length === 0) continue;
    lines.push(
      `## ${target}: ${dialectByCode(target)?.promptName ?? target}`,
      "",
      ...armTable(input, scope),
      "",
      `- B minus A: ${interval(differenceVsA(input, scope, "B", target))}`,
      `- C minus A: ${interval(differenceVsA(input, scope, "C", target))}`,
      "",
    );
  }
  lines.push("## Error tags the judge gave", "", `| arm | ${ERROR_TAGS.join(" | ")} |`, `|-----|${ERROR_TAGS.map(() => "---").join("|")}|`);
  for (const arm of ARMS) {
    const s = armStats(input, input.selected, arm.id);
    lines.push(`| ${arm.id} | ${ERROR_TAGS.map((t) => String(s.errorTags[t] ?? 0)).join(" | ")} |`);
  }
  const ledger = totals(load({ root: input.root }));
  lines.push(
    "",
    "## Spend",
    "",
    `This run (ledger program ${PROGRAMS.blindTest}, room ${input.runRoom}): ${spend.rows} rows, ${usd(spend.totalUsd)} in all, ` +
      `${usd(spend.translateUsd)} on translations and ${usd(spend.judgeUsd)} on the judge, against a budget of ` +
      `$${input.budgetUsd.toFixed(2)} (judge $${input.judgeBudgetUsd.toFixed(2)}).`,
    spend.lostRows > 0
      ? `${spend.lostRows} of those rows are calls that never answered, counted at their worst case (${usd(spend.lostUsd)}), so the total is an upper bound.`
      : "Every call answered, so every row carries its real cost.",
    "",
    `The whole ledger${input.dryRun ? " (the dry run's temporary one)" : ""}, by program, known costs only` +
      (ledger.unparsed_rows > 0 ? ` (${ledger.unparsed_rows} rows have no recoverable cost, so these are floors)` : "") +
      ":",
    "",
    "| program | spent | calls |",
    "|---------|-------|-------|",
  );
  for (const program of Object.values(ledger.programs).sort((a, b) => a.program.localeCompare(b.program))) {
    lines.push(`| ${program.program} | ${usd(program.spent_usd)} | ${program.entries} |`);
  }
  lines.push("", `Known total: ${usd(ledger.known_usd)} across ${ledger.entries} calls.`, "");
  return `${lines.join("\n")}\n`;
}

// ------------------------------------------------------------------------------------------------
// The human sheet and its key

const csvCell = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export interface SheetRow {
  row: string;
  item: BlindItem;
  duplicateOf: string | null;
  candidates: Array<{ label: number; text: string; arms: ArmId[] }>;
}

/**
 * Every selected item with at least one translation, plus one in DUPLICATE_EVERY of them a second
 * time with its candidates in a different order, all in a seeded random row order. The sheet's
 * candidate order is drawn separately from the judge's, so judge.jsonl is no key to it.
 */
export function sheetRows(input: ReportInput): SheetRow[] {
  const rated = input.selected
    .map((item) => ({ item, candidates: BlindRun.candidates(item.id, input.outputs, input.seed, "sheet") }))
    .filter((r) => r.candidates.length > 0);
  const duplicates = shuffled(rated, rng(seedFrom(`${input.seed}:duplicates`))).slice(0, Math.round(rated.length / DUPLICATE_EVERY));
  const all = [
    ...rated.map((r) => ({ ...r, duplicate: false })),
    ...duplicates.map((r) => ({ item: r.item, candidates: BlindRun.candidates(r.item.id, input.outputs, input.seed, "sheet-again"), duplicate: true })),
  ];
  const ordered = shuffled(all, rng(seedFrom(`${input.seed}:rows`)));
  // A rater who meets the same line twice in a row is not checked for agreement, only for memory:
  // a copy next to its original is swapped half the sheet away (deterministically, so the sheet is
  // still a function of the seed).
  for (let i = 0; i < ordered.length && ordered.length > 3; i += 1) {
    const here = ordered[i]!;
    const neighbour = (k: number) => ordered[k]?.item.id === here.item.id;
    if (!neighbour(i - 1) && !neighbour(i + 1)) continue;
    const j = (i + Math.floor(ordered.length / 2)) % ordered.length;
    [ordered[i], ordered[j]] = [ordered[j]!, ordered[i]!];
  }
  const width = String(ordered.length).length;
  const rowIds = ordered.map((_, i) => `R${String(i + 1).padStart(Math.max(3, width), "0")}`);
  return ordered.map((r, i) => ({
    row: rowIds[i]!,
    item: r.item,
    candidates: r.candidates,
    duplicateOf: r.duplicate ? rowIds[ordered.findIndex((o) => !o.duplicate && o.item.id === r.item.id)]! : null,
  }));
}

export function renderSheet(input: ReportInput, rows: readonly SheetRow[]): string {
  const header = [
    "row", "item_id", "target", "context", "source", "candidate_1", "candidate_2", "candidate_3",
    "score_1", "score_2", "score_3", "right_dialect_1", "right_dialect_2", "right_dialect_3", "notes",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    const target = dialectByCode(row.item.tgt);
    const text = (label: number) => row.candidates.find((c) => c.label === label)?.text ?? "";
    lines.push(
      [
        row.row,
        row.item.id,
        `${target?.promptName ?? row.item.tgt} (${row.item.tgt})`,
        contextFor(input.items, row.item).map((t) => t.text).join("\n"),
        row.item.text,
        text(1), text(2), text(3),
        "", "", "", "", "", "", "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function renderKey(input: ReportInput, rows: readonly SheetRow[]): string {
  const key = {
    run_id: input.runId,
    note: "The unblinding key for rating_sheet.csv. Keep it away from raters until the sheet is filled in.",
    arms: Object.fromEntries(ARMS.map((a) => [a.id, { model: a.model, label: a.label }])),
    rows: Object.fromEntries(
      rows.map((row) => [
        row.row,
        {
          item: row.item.id,
          duplicate_of: row.duplicateOf,
          candidates: Object.fromEntries(row.candidates.map((c) => [String(c.label), c.arms])),
          not_shown: Object.fromEntries(
            ARMS.filter((a) => !row.candidates.some((c) => c.arms.includes(a.id))).map((a) => [
              a.id,
              input.outputs.get(`${row.item.id}:${a.id}`)?.status ?? "not run",
            ]),
          ),
        },
      ]),
    ),
  };
  return `${JSON.stringify(key, null, 2)}\n`;
}

export function writeReports(runDir: string, input: ReportInput): void {
  const rows = sheetRows(input);
  writeFileSync(join(runDir, "rating_sheet.csv"), renderSheet(input, rows), "utf8");
  writeFileSync(join(runDir, "key.json"), renderKey(input, rows), "utf8");
  writeFileSync(join(runDir, "report.md"), renderReport(input), "utf8");
}
