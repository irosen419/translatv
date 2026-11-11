// The blind test run, end to end, against fake clients and temporary ledgers. No key, no network,
// no money: what is pinned is that every call reaches the ledger before its result is used, that
// the budget is read off the ledger and stops the run cleanly, that a rerun pays for nothing twice,
// and that the judge is blind.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROGRAMS } from "../../spend/caps.js";
import { append, ledgerPath, load } from "../../spend/ledger.js";
import { profileFor, type RequestProfile } from "../../translate/anthropic.js";
import { LlmFailure, requestWorstCaseUsd, type LlmClient } from "../../translate/TranslationService.js";
import { ARMS, JUDGE_MODEL } from "./arms.js";
import { main } from "./cli.js";
import { fakeClient } from "./fake.js";
import { parseItems } from "./items.js";
import { BlindRun, readJsonl, sha256, type JudgeRecord, type OutputRecord, type RunConfig, type RunDeps } from "./runner.js";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");
const SET_TEXT = readFileSync(join(REPO, "eval", "blind", "sentences.jsonl"), "utf8");
const ITEMS = parseItems(SET_TEXT);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerRoot(withLedger = true): string {
  const root = mkdtempSync(join(tmpdir(), "blind-run-"));
  roots.push(root);
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  if (withLedger) writeFileSync(ledgerPath(root), "", "utf8");
  return root;
}

function config(root: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    root,
    runId: "test-run",
    runDir: join(root, "out", "translatv", "blind", "test-run"),
    items: ITEMS,
    setSha256: sha256(SET_TEXT),
    limit: 5,
    budgetUsd: 6,
    judgeBudgetUsd: 4,
    judge: true,
    dryRun: true,
    ...overrides,
  };
}

/** Wraps the fake, counting calls per model and remembering every prompt. */
function counting(override?: (model: string, profile: RequestProfile, fallback: LlmClient) => LlmClient) {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const clientFor: RunDeps["clientFor"] = (model, profile) => {
    const base = fakeClient(model, profile);
    const inner = override ? override(model, profile, base) : base;
    return {
      complete(input) {
        calls.push({ model, system: input.system, user: input.user });
        return inner.complete(input);
      },
    };
  };
  return { clientFor, calls };
}

const quiet = () => undefined;

function runRows(root: string, run: BlindRun) {
  return load({ root }).filter((r) => r.program === PROGRAMS.blindTest && r.room === run.runRoom);
}

describe("a run", () => {
  it("translates every arm, then judges, and logs one ledger row per call, each before its result is used", async () => {
    const root = ledgerRoot();
    const seen: string[] = [];
    // Every append is observed alongside what outputs.jsonl held at that moment: a row must never
    // trail the output line it pays for.
    const run: BlindRun = new BlindRun(config(root), {
      ...counting(),
      log: quiet,
      appendRecord: (record, at) => {
        seen.push(`${(record as { note: string }).note}|${readJsonl<OutputRecord>(run.outputsPath).length}|${readJsonl<JudgeRecord>(run.judgePath).length}`);
        append(record, at);
      },
    });
    const summary = await run.execute();
    expect(summary).toMatchObject({ selected: 5, translationsRecorded: 15, judged: 5, stops: [], disabled: {} });

    const outputs = readJsonl<OutputRecord>(run.outputsPath);
    const judged = readJsonl<JudgeRecord>(run.judgePath);
    const rows = runRows(root, run);
    expect(rows).toHaveLength(outputs.length + judged.length);
    for (const output of outputs) {
      const row = rows.find((r) => r.note === `blind test-run translate ${output.arm} ${output.item}`);
      expect(row?.cost_usd).toBe(output.cost_usd);
      expect(row?.model).toBe(output.model);
      expect(row?.cap_usd).toBe(6);
    }
    // At each append, the outputs written so far are fewer than the rows appended so far.
    seen.forEach((line, index) => {
      const [, outputsAtAppend, judgedAtAppend] = line.split("|").map(Number);
      expect(outputsAtAppend! + judgedAtAppend!).toBeLessThanOrEqual(index);
    });
    // No transcript text in any row.
    for (const item of ITEMS.slice(0, 50)) expect(JSON.stringify(rows)).not.toContain(item.text);
  });

  it("sends each arm the production prompt with the conversation's earlier lines, and no glossary", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting();
    await new BlindRun(config(root, { limit: 10, judge: false }), { clientFor, log: quiet }).execute();
    const translations = calls.filter((c) => c.model !== JUDGE_MODEL);
    expect(translations).toHaveLength(30);
    for (const call of translations) {
      expect(call.system).toContain("You are a live subtitle translator");
      expect(call.system).not.toContain("SESSION GLOSSARY");
    }
    expect(translations.some((c) => c.user.includes("<context>"))).toBe(true);
  });

  it("keeps the judge blind: no model, no arm, labels 1 to n, identical outputs shown once", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting();
    const run = new BlindRun(config(root, { limit: 25 }), { clientFor, log: quiet });
    await run.execute();
    const judgeCalls = calls.filter((c) => c.model === JUDGE_MODEL);
    expect(judgeCalls.length).toBeGreaterThan(0);
    for (const call of judgeCalls) {
      const prompt = `${call.system}\n${call.user}`.toLowerCase();
      for (const word of ["haiku", "sonnet", "claude", "4.5", "5.5", "arm "]) expect(prompt).not.toContain(word);
      expect(call.system).toContain("BLIND");
      const data = JSON.parse(/<data>\n([\s\S]*)\n<\/data>/.exec(call.user)![1]!) as { candidates: Record<string, string> };
      const labels = Object.keys(data.candidates);
      expect(labels).toEqual(labels.map((_, i) => String(i + 1)));
      expect(new Set(Object.values(data.candidates)).size).toBe(labels.length);
    }
    // The fake makes B and C agree on some lines: those were shown, and scored, once.
    const judged = readJsonl<JudgeRecord>(run.judgePath);
    expect(judged.some((j) => j.labels.some((l) => l.arms.length === 2))).toBe(true);
  });

  it("judges in an order that cycles through the targets", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting();
    await new BlindRun(config(root, { limit: 10 }), { clientFor, log: quiet }).execute();
    const targets = calls
      .filter((c) => c.model === JUDGE_MODEL)
      .slice(0, 5)
      .map((c) => /TARGET VARIETY: (.*)/.exec(c.user)![1]);
    expect(new Set(targets).size).toBe(5);
  });

  it("records a refusal as a failure with its cost, never as a translation, and never shows it to the judge", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting((model, profile, base) =>
      profile.thinking === "adaptive"
        ? { complete: async () => ({ text: "", inputTokens: 900, outputTokens: 40, stopReason: "refusal" }) }
        : base,
    );
    const run = new BlindRun(config(root), { clientFor, log: quiet });
    await run.execute();
    const c = readJsonl<OutputRecord>(run.outputsPath).filter((r) => r.arm === "C");
    expect(c.every((r) => r.status === "refusal" && r.cost_usd !== null)).toBe(true);
    for (const record of readJsonl<JudgeRecord>(run.judgePath)) {
      expect(record.labels.flatMap((l) => l.arms)).not.toContain("C");
    }
    expect(calls.filter((x) => x.model === JUDGE_MODEL)).toHaveLength(5);
  });
});

describe("spend", () => {
  it("logs a request lost in flight at its worst case, the moment it is reported, and retries it", async () => {
    const root = ledgerRoot();
    let failed = false;
    const { clientFor } = counting((model, profile, base) =>
      model === "claude-haiku-4-5"
        ? {
            async complete(input) {
              if (!failed) {
                failed = true;
                input.onLost();
                throw new LlmFailure("retriable", "connection", "lost");
              }
              return base.complete(input);
            },
          }
        : base,
    );
    const run = new BlindRun(config(root, { limit: 1, judge: false }), { clientFor, log: quiet });
    await run.execute();
    const lost = runRows(root, run).filter((r) => r.cost_usd === null);
    expect(lost).toHaveLength(1);
    const item = run.selected()[0]!;
    const { buildSystemPrompt, buildUserMessage } = await import("../../translate/prompt.js");
    const { dialectByCode } = await import("@translatv/shared");
    const { contextFor } = await import("./items.js");
    const expected = requestWorstCaseUsd(
      "claude-haiku-4-5",
      buildSystemPrompt(dialectByCode(item.src)!, dialectByCode(item.tgt)!, []),
      buildUserMessage(contextFor(ITEMS, item), item.text),
      profileFor("claude-haiku-4-5")!.maxTokens,
    );
    expect(lost[0]?.worst_case_usd).toBe(expected);
    // The second pass retried it, and the retry's answer is what counts.
    const a = readJsonl<OutputRecord>(run.outputsPath).filter((r) => r.arm === "A");
    expect(a.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("stops cleanly when the next call would pass the budget, having spent no more than it", async () => {
    const root = ledgerRoot();
    const run = new BlindRun(config(root, { limit: 25, budgetUsd: 0.02, judgeBudgetUsd: 0.02 }), { ...counting(), log: quiet });
    const summary = await run.execute();
    expect(summary.stops[0]).toMatch(/run budget of \$0\.02 would be exceeded/);
    const spent = runRows(root, run).reduce((t, r) => t + (r.cost_usd ?? r.worst_case_usd ?? 0), 0);
    expect(spent).toBeLessThanOrEqual(0.02);
    expect(spent).toBeGreaterThan(0);
  });

  it("reserves a worst case for every request a call may send, the adapter's retry included", async () => {
    // A call can be two requests (a lost one, then its retry), so a budget that fits one request's
    // worst case but not two must not start it: that is what keeps the budget a hard cap.
    const root = ledgerRoot();
    const probe = new BlindRun(config(root, { limit: 1 }), { ...counting(), log: quiet });
    const item = probe.selected().find((i) => i.tgt === "es-AR")!;
    const { buildSystemPrompt, buildUserMessage } = await import("../../translate/prompt.js");
    const { dialectByCode } = await import("@translatv/shared");
    const { contextFor } = await import("./items.js");
    const one = requestWorstCaseUsd(
      "claude-haiku-4-5",
      buildSystemPrompt(dialectByCode(item.src)!, dialectByCode(item.tgt)!, []),
      buildUserMessage(contextFor(ITEMS, item), item.text),
      512,
    )!;
    const { clientFor, calls } = counting();
    const run = new BlindRun(config(root, { limit: 1, judge: false, budgetUsd: one * 1.5 }), { clientFor, log: quiet });
    const summary = await run.execute();
    expect(calls).toHaveLength(0);
    expect(summary.stops[0]).toMatch(/run budget/);
  });

  it("counts spend already on the ledger for this run, so a rerun cannot spend its budget twice", async () => {
    const root = ledgerRoot();
    const first = new BlindRun(config(root, { limit: 5, judge: false }), { ...counting(), log: quiet });
    await first.execute();
    const spent = runRows(root, first).reduce((t, r) => t + (r.cost_usd ?? 0), 0);
    // Ten more items with a budget just above what is already spent: refused at once.
    const { clientFor, calls } = counting();
    const more = new BlindRun(config(root, { limit: 5, judge: true, budgetUsd: spent + 0.000001, judgeBudgetUsd: 4 }), { clientFor, log: quiet });
    const summary = await more.execute();
    expect(calls).toHaveLength(0);
    expect(summary.stops[0]).toMatch(/budget/);
  });

  it("holds the judge to its own budget, and the translations are all done first", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting();
    const run = new BlindRun(config(root, { limit: 10, judgeBudgetUsd: 0.2 }), { clientFor, log: quiet });
    const summary = await run.execute();
    expect(summary.translationsRecorded).toBe(30);
    expect(summary.judged).toBeLessThan(10);
    expect(summary.stops[0]).toMatch(/judge budget/);
    const firstJudge = calls.findIndex((c) => c.model === JUDGE_MODEL);
    expect(calls.slice(firstJudge).every((c) => c.model === JUDGE_MODEL)).toBe(true);
    const judgeSpent = runRows(root, run).filter((r) => r.model === JUDGE_MODEL).reduce((t, r) => t + (r.cost_usd ?? 0), 0);
    expect(judgeSpent).toBeLessThanOrEqual(0.2);
    expect(summary.judged).toBeGreaterThan(0);
  });

  it("stops the run, and writes no output for it, when a row cannot be appended", async () => {
    const root = ledgerRoot();
    let appends = 0;
    const { clientFor, calls } = counting();
    const run = new BlindRun(config(root, { limit: 5 }), {
      clientFor,
      log: quiet,
      appendRecord: (record, at) => {
        appends += 1;
        if (appends === 3) throw new Error("EACCES fake");
        append(record, at);
      },
    });
    await expect(run.execute()).rejects.toThrow(/could not be written/);
    // Calls already in flight finish and are recorded, each output with its row. The one whose row
    // failed has no output, and nothing new was started once it failed.
    const outputs = readJsonl<OutputRecord>(run.outputsPath);
    const rows = runRows(root, run);
    expect(outputs).toHaveLength(rows.length);
    expect(calls).toHaveLength(rows.length + 1);
    expect(calls.length).toBeLessThan(15);
  });

  it("logs a call whose row the ledger refuses at its worst case, and stops", async () => {
    // A usage that cannot be priced consistently (here, a token count that is not a number) is
    // refused by entry(). The call still cost money, so it is logged as unknown, at its worst case.
    const root = ledgerRoot();
    const { clientFor } = counting((model, profile, base) =>
      model === "claude-haiku-4-5" ? { complete: async () => ({ text: "hola", inputTokens: Number.NaN, outputTokens: 5, stopReason: "end_turn" }) } : base,
    );
    const run = new BlindRun(config(root, { limit: 1, judge: false }), { clientFor, log: quiet });
    await expect(run.execute()).rejects.toThrow(/ledger refused a row/);
    const unknown = runRows(root, run).filter((r) => r.cost_usd === null);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.worst_case_usd).toBeGreaterThan(0);
    expect(readJsonl<OutputRecord>(run.outputsPath).some((r) => r.arm === "A")).toBe(false);
  });

  it("refuses to start without a ledger, and makes no call", async () => {
    const root = ledgerRoot(false);
    const { clientFor, calls } = counting();
    await expect(new BlindRun(config(root), { clientFor, log: quiet }).execute()).rejects.toThrow(/no ledger/);
    expect(calls).toHaveLength(0);
  });
});

describe("resuming", () => {
  it("pays for nothing it already has", async () => {
    const root = ledgerRoot();
    await new BlindRun(config(root), { ...counting(), log: quiet }).execute();
    const { clientFor, calls } = counting();
    const again = await new BlindRun(config(root), { clientFor, log: quiet }).execute();
    expect(calls).toHaveLength(0);
    expect(again).toMatchObject({ translationsRecorded: 15, judged: 5 });
  });

  it("refuses to resume a run with a different limit", async () => {
    const root = ledgerRoot();
    await new BlindRun(config(root), { ...counting(), log: quiet }).execute();
    await expect(new BlindRun(config(root, { limit: 10 }), { ...counting(), log: quiet }).execute()).rejects.toThrow(/Resume it with the same settings/);
  });

  it("switches off an arm whose failure retrying cannot fix, records nothing for it, and judges nothing unpaired", async () => {
    const root = ledgerRoot();
    const { clientFor, calls } = counting((model, profile, base) =>
      model === "claude-haiku-5-5"
        ? {
            complete: async () => {
              throw new LlmFailure("terminal", "bad_request", "malformed");
            },
          }
        : base,
    );
    const run = new BlindRun(config(root), { clientFor, log: quiet });
    const summary = await run.execute();
    expect(Object.keys(summary.disabled).sort()).toEqual(["B", "C"]);
    expect(readJsonl<OutputRecord>(run.outputsPath).every((r) => r.arm === "A")).toBe(true);
    expect(calls.filter((c) => c.model === JUDGE_MODEL)).toHaveLength(0);
    // Each disabled arm stopped after the calls already started, not after every item.
    expect(calls.filter((c) => c.model === "claude-haiku-5-5").length).toBeLessThanOrEqual(8);
  });
});

describe("npm run blind", () => {
  function io(extra: Partial<Parameters<typeof main>[2]> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), repoRoot: REPO, ...extra } };
  }

  it("runs the whole pipeline as a dry run, and writes the report, the sheet and its key", async () => {
    const { out, io: options } = io();
    const code = await main(["--dry-run", "--limit", "10"], {}, options);
    expect(code).toBe(0);
    const dir = /dry run files are in (.*)$/.exec(out.at(-1)!)![1]!;
    roots.push(dir);
    const runDir = join(dir, "out", "translatv", "blind", /blind run (\S+)/.exec(out[0]!)![1]!);
    for (const file of ["outputs.jsonl", "judge.jsonl", "report.md", "rating_sheet.csv", "key.json", "run.json"]) {
      expect(existsSync(join(runDir, file))).toBe(true);
    }
    const report = readFileSync(join(runDir, "report.md"), "utf8");
    expect(report).toContain("DRY RUN");
    expect(report).toContain("B minus A");
    expect(report).toContain("SYNTHETIC");
    expect(report).not.toMatch(/[–—]/);

    // The sheet: blind (no arm, no model), one row per item plus one in five again, with a key.
    const sheet = readFileSync(join(runDir, "rating_sheet.csv"), "utf8");
    expect(sheet.toLowerCase()).not.toContain("haiku");
    const key = JSON.parse(readFileSync(join(runDir, "key.json"), "utf8")) as { rows: Record<string, { item: string; duplicate_of: string | null }> };
    const rows = Object.values(key.rows);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.duplicate_of !== null)).toHaveLength(2);
    // The real ledger was not touched.
    expect(load({ root: dir }).length).toBe(40);
  });

  it("refuses to start a real run without ANTHROPIC_API_KEY, and never prints a key", async () => {
    const { err, io: options } = io();
    expect(await main(["--limit", "10"], {}, options)).toBe(1);
    expect(err.join("\n")).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("refuses a real run whose ledger is missing, before any call", async () => {
    const root = ledgerRoot(false);
    mkdirSync(join(root, "eval", "blind"), { recursive: true });
    writeFileSync(join(root, "eval", "blind", "sentences.jsonl"), SET_TEXT, "utf8");
    const { clientFor, calls } = counting();
    const { err, io: options } = io({ repoRoot: root, clientFor });
    expect(await main(["--limit", "5"], { ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key" }, options)).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toMatch(/no ledger/);
    expect(err.join("\n")).not.toContain("sk-ant-fake");
  });

  it("finishes early with exit code 3 when the budget stops it, and says how to resume", async () => {
    const root = ledgerRoot();
    mkdirSync(join(root, "eval", "blind"), { recursive: true });
    writeFileSync(join(root, "eval", "blind", "sentences.jsonl"), SET_TEXT, "utf8");
    const { out, io: options } = io({ repoRoot: root, clientFor: counting().clientFor });
    const code = await main(["--limit", "25", "--budget-usd", "0.02", "--run-id", "smoke"], { ANTHROPIC_API_KEY: "sk-ant-fake-not-a-key" }, options);
    expect(code).toBe(3);
    expect(out.join("\n")).toMatch(/Resume with: npm run blind -- --run-id smoke --limit 25/);
    const report = readFileSync(join(root, "out", "translatv", "blind", "smoke", "report.md"), "utf8");
    expect(report).toContain("The run stopped early");
    // The view was regenerated, so check:spend-view stays clean after a run.
    expect(existsSync(join(root, "out", "translatv", "spend_log.md"))).toBe(true);
  });

  it("rejects an unknown flag and a bad budget", async () => {
    expect(await main(["--frobnicate"], {}, io().io)).toBe(1);
    expect(await main(["--budget-usd", "-1", "--dry-run"], {}, io().io)).toBe(1);
  });
});

it("names the arms the plan names", () => {
  expect(ARMS.map((a) => [a.id, a.model, a.profile.thinking, a.profile.effort])).toEqual([
    ["A", "claude-haiku-4-5", "omit", null],
    ["B", "claude-haiku-5-5", "disabled", null],
    ["C", "claude-haiku-5-5", "adaptive", "low"],
  ]);
  // A is production's own profile object's values, and A and B ask for the same max_tokens.
  expect(ARMS[0]!.profile).toEqual(profileFor("claude-haiku-4-5"));
  expect(ARMS[1]!.profile.maxTokens).toBe(ARMS[0]!.profile.maxTokens);
  expect(ARMS[2]!.profile.maxTokens).toBeGreaterThanOrEqual(8 * ARMS[0]!.profile.maxTokens);
});
