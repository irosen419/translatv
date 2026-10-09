// The append only spend ledger: out/<project>/spend_log.jsonl, one JSON object per API call.
//
// This is a direct port of awws's spend_log.py contract, with one structural difference: awws
// spends in controlled nightly batches that the owner arms, while this project spends
// continuously as users talk. That makes the ledger a live, hot path component rather than a
// batch bookkeeping tool, which is why it is TypeScript here and why appends are synchronous
// single writes.
//
// The JSONL is the source of truth. spend_log.md beside it is a GENERATED VIEW: never parsed,
// never hand edited. Two readers exist (this file, and the standard library only spend_log.py
// CLI), and a shared fixture asserts they agree.
//
// The dashboard's Ruby SpendLedger reads this same file, so the field names ts, cost_usd,
// program, cap_usd, and record_type are a wire contract with it, not free choices.
//
// image_count is NOT one of them, despite once being listed here as though it were. Its reader is
// `value.is_a?(Numeric) ? value.to_i : 0`, so an absent key already sums as zero. This project
// renders nothing, so the field could only ever hold 0, and a column with one possible value is
// noise on every row. Rows written before this was removed still carry it, which is fine: the
// ledger is append only and both readers ignore unknown keys.
//
// Four honesty rules drive the shape. Each one is a bug that has already shipped once, in awws:
//
//   1. A missing ledger RAISES. It is not an empty list. "No ledger" and "spent nothing" are
//      different facts, and a cap gate that confuses them buys exactly the calls the cap
//      existed to prevent.
//   2. An unrecoverable cost is null, NEVER zero. A zero is summed as though the call were
//      free and silently understates the total.
//   3. Totals report known_usd alongside unparsed_rows, so a partial total is presented as a
//      floor rather than as a precise figure quietly missing rows.
//   4. A stated cost that contradicts its own token counts and unit prices is refused at write
//      time rather than stored. The harmful direction is under-logging.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { costUsd, MONEY_PRECISION, priceFor, roundMoney } from "./pricing.js";

export const LEDGER_FILE = "spend_log.jsonl";
export const MARKDOWN_FILE = "spend_log.md";

/** The slug this project's ledger lives under: out/<slug>/spend_log.jsonl. */
export const PROJECT_SLUG = "translatv";

/**
 * Stamped into every generated markdown view.
 *
 * Its presence is what lets any future migration refuse to parse a generated file as though it
 * were a hand written source, which in awws silently mis-read every row and then overwrote the
 * real ledger with the result.
 */
export const GENERATED_BANNER = `Generated from ${LEDGER_FILE}.`;

/** A metadata line. Kept out of the record stream so a consumer cannot sum it into a total. */
export const HEADER_TYPE = "header";

/**
 * Where a cost came from, worst to best. A consumer that wants only trustworthy money filters
 * on "logged".
 *
 *   logged    the API response reported its own token usage and the price is documented
 *   derived   computed by differencing cumulative totals. Real, but approximate.
 *   unparsed  no amount could be recovered. cost_usd is null, never zero.
 */
export const COST_SOURCES = ["logged", "derived", "unparsed"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** What kind of work spent the money. */
export const SPEND_KINDS = ["translation", "term-extraction", "eval", "verification"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

/**
 * How far a stated cost may sit from its own token counts times unit prices before entry()
 * refuses it. RELATIVE, deliberately, with a tiny absolute floor.
 *
 * awws uses an absolute half cent here, which is right when one unit of work is an image
 * costing about $0.13. It is badly wrong in this repo: one translated turn costs about
 * $0.001, so any absolute tolerance near a tenth of a cent would accept a cost off by 100
 * percent and the check would silently never fire. That mistake was made once here and caught
 * by the test below, which is why the reasoning is written down.
 *
 * A real mismatch is off by a whole model's pricing, so it is enormous in relative terms.
 * Binary floating point noise is around 1e-16 relative. A 0.1 percent relative band sits
 * several orders of magnitude clear of both.
 */
export const COST_TOLERANCE_RELATIVE = 0.001;

/**
 * Absolute floor for the tolerance, so a legitimately tiny or zero expected cost does not get
 * a tolerance of zero and start refusing rows over pure float noise.
 */
export const COST_TOLERANCE_FLOOR_USD = 1e-9;

export interface SpendRecord {
  ts: string | null;
  project: string;
  program: string | null;
  kind: SpendKind | null;
  model: string | null;
  /** A truncated sha256 of the room code. NEVER the code, and never transcript text. */
  room: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  unit_cost_in_usd_per_mtok: number | null;
  unit_cost_out_usd_per_mtok: number | null;
  cost_usd: number | null;
  cost_source: CostSource;
  cumulative_usd: number | null;
  cap_usd: number | null;
  note: string;
  /**
   * Only on a row whose cost is unknown (a call that never answered, or whose connection was
   * lost, may still have been billed): the most it could have cost. The spend gate counts it
   * against the caps in place of the missing cost. Totals do not: known_usd stays a floor.
   */
  worst_case_usd?: number;
  /**
   * Only as false: spend no user may be charged for, because nothing reached them (a request
   * that answered after the caller gave up, that never answered, or that answered with nothing).
   * The house pays it (owner decision, 2026-09-28). Absent means billable, which is every ordinary
   * row, so older rows need no rewrite.
   */
  billable?: false;
}

export interface HeaderRecord {
  record_type: typeof HEADER_TYPE;
  project: string;
  [key: string]: unknown;
}

export interface ProgramTotal {
  program: string;
  spent_usd: number;
  cap_usd: number | null;
  entries: number;
}

export interface Totals {
  known_usd: number;
  unparsed_rows: number;
  entries: number;
  input_tokens: number;
  output_tokens: number;
  programs: Record<string, ProgramTotal>;
}

/**
 * Raised when a project has no ledger at all.
 *
 * Deliberately not an empty list: a project with no ledger has UNKNOWN spend, and the pre-call
 * budget gate must never read that as zero spent and wave a paid call through against a cap it
 * cannot see.
 */
export class LedgerNotFound extends Error {
  constructor(path: string) {
    super(`no ledger at ${path}`);
    this.name = "LedgerNotFound";
  }
}

/** Raised rather than overwrite a real markdown view from an empty ledger. */
export class RefusedWrite extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedWrite";
  }
}

export function ledgerPath(root: string, project: string = PROJECT_SLUG): string {
  return join(root, "out", project, LEDGER_FILE);
}

export function markdownPath(root: string, project: string = PROJECT_SLUG): string {
  return join(root, "out", project, MARKDOWN_FILE);
}

/**
 * Is the ledger on the same device as the filesystem root?
 *
 * A proxy for "baked into the image rather than mounted", and the reason it matters is that an
 * ephemeral ledger resets the day's observed spend on every restart. The cap is meant to be
 * cumulative; a container that crash loops would re arm it each time and spend the daily budget
 * repeatedly, with each individual run looking perfectly well behaved.
 *
 * A proxy, not a proof: a bare metal host legitimately keeps everything on one device, which is
 * why the caller offers an explicit override rather than treating this as certain.
 */
export function isEphemeralLedger(root: string, project: string = PROJECT_SLUG): boolean {
  try {
    return statSync(join(root, "out", project)).dev === statSync("/").dev;
  } catch {
    // Cannot tell. Say no rather than blocking a boot over a question that could not be asked.
    return false;
  }
}

/**
 * Can this process actually append to the ledger?
 *
 * A separate question from whether it can READ one, and the reason it needs asking is a bug that
 * shipped: the image copied the ledger in as root and then dropped to an unprivileged user, so
 * every append failed EACCES for the life of the container. Nothing stopped: the file still
 * existed and still parsed, so the cap gate kept reading a stale ledger and kept allowing calls.
 * Spend continued, permanently untracked, behind one warning line per call. Unreadable already
 * refuses. Unwritable has to refuse too, and this is what lets the caller do it at boot rather
 * than discovering it one lost row at a time.
 *
 * Opens for update and writes NOTHING. Two details are load bearing and neither is obvious:
 *
 *   The existence check comes FIRST, and a missing ledger is a no rather than a yes. This
 *     function must never bring one into being. "a" would have: the append flag creates the file
 *     when it is absent, which would quietly convert "no ledger" into "an empty ledger" and hand
 *     the cap gate zero spend to reason from. That is the same confusion load() raises over,
 *     arriving through a side door.
 *   "r+" rather than "w" or "a", because it needs write permission without creating and without
 *     truncating. Probing the source of truth must not be able to damage it.
 */
export function ledgerWritable(
  root: string,
  project: string = PROJECT_SLUG,
): { ok: true } | { ok: false; reason: string } {
  const path = ledgerPath(root, project);
  if (!existsSync(path)) return { ok: false, reason: `no ledger at ${path}` };

  let handle: number | null = null;
  try {
    handle = openSync(path, "r+");
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "unknown" };
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

function moneyText(value: number): string {
  return String(roundMoney(value));
}

/**
 * Refuse a cost that contradicts its own token counts and unit prices.
 *
 * Silent when any input is absent, which is not an oversight: a narrative note row carries no
 * tokens and has nothing to check. Only a row stating all of cost, tokens, and prices is
 * checked, and such a row disagreeing with itself is a bookkeeping error that would misreport
 * spend against a cap.
 */
function checkCostConsistency(
  costUsdValue: number | null,
  inputTokens: number | null,
  outputTokens: number | null,
  inRate: number | null,
  outRate: number | null,
): void {
  if (
    costUsdValue === null ||
    inputTokens === null ||
    outputTokens === null ||
    inRate === null ||
    outRate === null
  ) {
    return;
  }

  const expected =
    (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
  const tolerance = Math.max(
    COST_TOLERANCE_FLOOR_USD,
    Math.abs(expected) * COST_TOLERANCE_RELATIVE,
  );
  if (Math.abs(costUsdValue - expected) <= tolerance) return;

  throw new RangeError(
    `cost_usd ${moneyText(costUsdValue)} contradicts ${inputTokens} input and ` +
      `${outputTokens} output tokens at ${moneyText(inRate)}/${moneyText(outRate)} per MTok, ` +
      `which is ${moneyText(expected)}. A cost that disagrees with its own arithmetic ` +
      `misreports this call against its cap, so fix the row rather than logging it.`,
  );
}

export interface EntryOptions {
  program: string;
  kind: SpendKind;
  model: string;
  room?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Override the computed cost. Normally omitted so the price table does the arithmetic. */
  costUsdOverride?: number | null;
  costSource?: CostSource;
  cumulativeUsd?: number | null;
  capUsd?: number | null;
  note?: string;
  ts?: string | null;
  project?: string;
  /** See SpendRecord.worst_case_usd. Only for a row with no recoverable cost. */
  worstCaseUsd?: number | null;
  /** See SpendRecord.billable. */
  billable?: boolean;
}

/**
 * Build one ledger record.
 *
 * cost_source defaults to "logged" when a cost was recovered and "unparsed" when it was not,
 * which is right for a live append: the API reported its own usage. A model with no documented
 * price yields a null cost and an "unparsed" source rather than a guess.
 *
 * Throws RangeError when a stated cost contradicts its own tokens and prices.
 */
export function entry(options: EntryOptions): SpendRecord {
  const {
    program,
    kind,
    model,
    room = null,
    inputTokens = null,
    outputTokens = null,
    costUsdOverride,
    cumulativeUsd = null,
    capUsd = null,
    note = "",
    ts = new Date().toISOString(),
    project = PROJECT_SLUG,
    worstCaseUsd = null,
    billable = true,
  } = options;

  const price = priceFor(model);
  const inRate = price?.inputUsdPerMTok ?? null;
  const outRate = price?.outputUsdPerMTok ?? null;

  const resolvedCost =
    costUsdOverride !== undefined
      ? costUsdOverride
      : inputTokens !== null && outputTokens !== null
        ? costUsd(model, inputTokens, outputTokens)
        : null;

  checkCostConsistency(resolvedCost, inputTokens, outputTokens, inRate, outRate);

  const costSource: CostSource =
    options.costSource ?? (resolvedCost !== null ? "logged" : "unparsed");
  if (!COST_SOURCES.includes(costSource)) {
    throw new RangeError(
      `cost_source must be one of ${COST_SOURCES.join(", ")}, got ${String(costSource)}`,
    );
  }

  // A worst case stands in for a cost nobody could recover, and only for that: beside a known
  // cost it would be a second, contradicting figure for the same call.
  if (worstCaseUsd !== null) {
    if (resolvedCost !== null) {
      throw new RangeError("worst_case_usd is for a row whose cost is unknown, and this one has a cost");
    }
    if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0) {
      throw new RangeError(`worst_case_usd must be a non negative amount, got ${String(worstCaseUsd)}`);
    }
  }

  return {
    ts,
    project,
    program,
    kind,
    model,
    room,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    unit_cost_in_usd_per_mtok: inRate,
    unit_cost_out_usd_per_mtok: outRate,
    cost_usd: resolvedCost === null ? null : roundMoney(resolvedCost),
    cost_source: costSource,
    cumulative_usd: cumulativeUsd === null ? null : roundMoney(cumulativeUsd),
    cap_usd: capUsd,
    note,
    // Written only when they say something, so every ordinary row stays byte for byte as before.
    ...(worstCaseUsd !== null ? { worst_case_usd: roundMoney(worstCaseUsd) } : {}),
    ...(billable ? {} : { billable: false as const }),
  };
}

/**
 * Append one record, creating the file and its directory if needed.
 *
 * One synchronous write of a complete JSON object plus a newline, deliberately. The dashboard's
 * JsonlLedger skips and counts any line it cannot parse, so a torn write would silently drop
 * money from a total. A single write call of a fully serialized string cannot tear at the
 * newline boundary the reader splits on.
 */
export function append(record: SpendRecord | HeaderRecord, root: string): void {
  const project = String(record.project ?? PROJECT_SLUG);
  const path = ledgerPath(root, project);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");

  // Mark the view stale. Do NOT render it here.
  //
  // Rendering on every append was tried and reverted, and the reason is worth keeping: it reads
  // and reparses the WHOLE ledger and rewrites the WHOLE markdown, synchronously, per paid call.
  // Measured on a seeded ledger: 8.7ms at 1k rows, 133ms at 10k, 446ms at 50k. Synchronous means
  // the entire event loop, so at 10k rows every translated sentence froze every room, all
  // signaling, and all WebSocket traffic for an eighth of a second, getting worse forever. Total
  // bytes rewritten is quadratic in the number of calls.
  //
  // The header of this file already said why: appends are synchronous single writes because this
  // ledger is on the live path. A stale committed document is a repository hygiene problem, and
  // paying for it in server latency trades a real fault for a worse one. It is regenerated at
  // shutdown and on a slow timer instead, and `npm run check` fails when the committed view
  // disagrees with the ledger, which is what actually catches the original bug.
  staleViews.add(viewKey(root, project));
}

/**
 * Ledgers with rows appended since their view was last written.
 *
 * Keyed per root rather than a single flag, because a process can hold more than one ledger root:
 * every test does. A shared boolean would let one root's append mark another root's view stale,
 * which is a bug that only ever shows up as a confusing test.
 */
const staleViews = new Set<string>();

function viewKey(root: string, project: string): string {
  return `${root}::${project}`;
}

/** Has a row been appended to this ledger since its view was last written? */
export function viewIsStale(root: string, project: string = PROJECT_SLUG): boolean {
  return staleViews.has(viewKey(root, project));
}

/**
 * Rebuild the view if anything has changed since last time.
 *
 * Cheap when idle: one boolean. Call it from a slow timer and at shutdown, never from the paid
 * call path. Returns whether it actually wrote.
 */
export function flushView(root: string, project: string = PROJECT_SLUG): boolean {
  if (!staleViews.has(viewKey(root, project))) return false;
  try {
    renderMarkdown({ root, project, write: true });
    staleViews.delete(viewKey(root, project));
    return true;
  } catch {
    // Deliberately not fatal and deliberately not un-staling. A view that could not be written
    // stays stale so the next flush retries, and a failure here must never affect a call: an
    // unwritten ROW is untracked spend, an unwritten VIEW is a stale document.
    return false;
  }
}

function readLines(root: string, project: string): Array<Record<string, unknown>> {
  const path = ledgerPath(root, project);
  if (!existsSync(path)) throw new LedgerNotFound(path);

  const parsed: Array<Record<string, unknown>> = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      // A non object line is corrupt rather than empty. Skipping it silently would understate
      // a money total, which is the one failure this module exists to prevent, so it is
      // dropped here and counted by malformedLines below.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        parsed.push(value as Record<string, unknown>);
      }
    } catch {
      // Same reasoning: counted, not fatal, never silently absorbed into a total.
    }
  }
  return parsed;
}

export interface LoadOptions {
  root: string;
  project?: string;
  /**
   * Opt in to tolerating a missing ledger. Off by default so a budget gate cannot accidentally
   * read "no ledger" as "spent nothing". A caller that genuinely tolerates absence, such as a
   * listing view, sets this explicitly.
   */
  missingOk?: boolean;
}

/**
 * Every spend record, in file order (which is append order, and therefore chronology).
 *
 * Raises LedgerNotFound for a missing ledger unless missingOk is set. Header records are
 * metadata rather than spend and are not returned here; use loadHeaders for those.
 */
export function load(options: LoadOptions): SpendRecord[] {
  const { root, project = PROJECT_SLUG, missingOk = false } = options;
  let records: Array<Record<string, unknown>>;
  try {
    records = readLines(root, project);
  } catch (error) {
    if (error instanceof LedgerNotFound && missingOk) return [];
    throw error;
  }
  return records.filter((r) => r["record_type"] !== HEADER_TYPE) as unknown as SpendRecord[];
}

/** The metadata records. Never raises for a missing ledger: a preamble is not a budget question. */
export function loadHeaders(options: LoadOptions): HeaderRecord[] {
  const { root, project = PROJECT_SLUG } = options;
  try {
    return readLines(root, project).filter(
      (r) => r["record_type"] === HEADER_TYPE,
    ) as unknown as HeaderRecord[];
  } catch (error) {
    if (error instanceof LedgerNotFound) return [];
    throw error;
  }
}

/** How many lines could not be read as a JSON object. Non zero means totals are a floor. */
export function malformedLines(options: LoadOptions): number {
  const { root, project = PROJECT_SLUG } = options;
  const path = ledgerPath(root, project);
  if (!existsSync(path)) return 0;

  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return malformed;
}

/**
 * Aggregate records into the numbers a cap gate and the cockpit both read.
 *
 * known_usd sums only recovered costs. unparsed_rows counts what could not be recovered, so
 * the total can be presented as a floor with an honest caveat rather than as a precise figure
 * that quietly omits rows. Where a program's cap was raised mid program, the last cap seen
 * wins: that is the one in force now.
 */
export function totals(records: SpendRecord[]): Totals {
  let known = 0;
  let unparsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const programs: Record<string, ProgramTotal> = {};

  for (const record of records) {
    const cost = typeof record.cost_usd === "number" ? record.cost_usd : null;
    if (cost === null) unparsed += 1;
    else known += cost;

    inputTokens += record.input_tokens ?? 0;
    outputTokens += record.output_tokens ?? 0;

    const name = record.program;
    if (!name) continue;

    const bucket = (programs[name] ??= {
      program: name,
      spent_usd: 0,
      cap_usd: null,
      entries: 0,
    });
    bucket.entries += 1;
    if (cost !== null) bucket.spent_usd = roundMoney(bucket.spent_usd + cost);
    if (typeof record.cap_usd === "number") bucket.cap_usd = record.cap_usd;
  }

  return {
    known_usd: roundMoney(known),
    unparsed_rows: unparsed,
    entries: records.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    programs,
  };
}

/**
 * NULLISH, not null. An ABSENT key reads as undefined, and a `=== null` test walked straight
 * past it into .toFixed() and threw a TypeError. spend_log.py puts both cells through
 * _numeric(), which treats absent and null identically, so the two renderers disagreed on any
 * row missing a key: a row from another writer or a hand edit, which caps.ts's header
 * anticipates. flushView swallows the throw, so the symptom would have been a view that
 * silently stopped regenerating while check:spend-view failed CI blaming a stale ledger.
 */
function costCell(record: SpendRecord): string {
  if (record.cost_usd == null) return "unknown";
  const marker = record.cost_source === "logged" ? "" : " approx";
  return `$${record.cost_usd.toFixed(MONEY_PRECISION)}${marker}`;
}

/** Same nullish rule, same reason: an absent cap_usd prints empty, exactly as Python does. */
function capCell(record: SpendRecord): string {
  return record.cap_usd == null ? "" : `$${record.cap_usd.toFixed(2)}`;
}

/**
 * Regenerate the human readable view from the JSONL.
 *
 * The markdown is a view, not a source, so rebuilding it at any time is safe. An unrecovered
 * cost prints as "unknown" rather than as a zero, so reading the table cannot mislead.
 */
export function renderMarkdown(options: LoadOptions & { write?: boolean }): string {
  const { root, project = PROJECT_SLUG, write = false } = options;
  const records = load({ root, project });
  const summary = totals(records);
  const target = markdownPath(root, project);

  if (write && records.length === 0 && existsSync(target)) {
    // An empty ledger cannot be the source of truth for a markdown that already has content.
    // Writing here would replace a real record with a "$0.00" table, which is the destructive
    // case this guard exists for.
    throw new RefusedWrite(`refusing to overwrite ${target} from an empty ledger`);
  }

  const lines = [
    `# ${project} API spend ledger`,
    "",
    `${GENERATED_BANNER} Do not edit by hand: append through the ledger module and`,
    "regenerate this view.",
    "",
    `Known spend $${summary.known_usd.toFixed(4)} across ${summary.entries} calls, ` +
      `${summary.input_tokens} input and ${summary.output_tokens} output tokens.`,
  ];
  if (summary.unparsed_rows > 0) {
    lines.push(
      `${summary.unparsed_rows} entries carry no recoverable cost, so the total above is a floor.`,
    );
  }
  lines.push(
    "",
    "| ts | program | kind | model | in | out | cost | cap | note |",
    "|----|---------|------|-------|----|-----|------|-----|------|",
  );

  for (const record of records) {
    lines.push(
      `| ${record.ts ?? ""} | ${record.program ?? ""} | ${record.kind ?? ""} ` +
        `| ${record.model ?? ""} | ${record.input_tokens ?? ""} | ${record.output_tokens ?? ""} ` +
        `| ${costCell(record)} | ${capCell(record)} ` +
        `| ${(record.note || "").replace(/\|/g, " ")} |`,
    );
  }

  const text = `${lines.join("\n")}\n`;
  if (write) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }
  return text;
}
