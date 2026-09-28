// Tests for the TypeScript spend ledger.
//
// The EXPECTED_* constants are the shared contract with the Python reader. test_spend_log.py
// asserts the same numbers against the same fixture file, so if one implementation drifts, one
// of the two suites goes red. Change these only when the fixture genuinely changes, and change
// them in both places in the same commit.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  append,
  entry,
  GENERATED_BANNER,
  HEADER_TYPE,
  LedgerNotFound,
  ledgerPath,
  flushView,
  ledgerWritable,
  load,
  loadHeaders,
  malformedLines,
  markdownPath,
  PROJECT_SLUG,
  RefusedWrite,
  renderMarkdown,
  totals,
  viewIsStale,
  type SpendRecord,
} from "./ledger.js";
import { costUsd, priceFor, roundMoney } from "./pricing.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const FIXTURE_ROOT = join(HERE, "..", "..", "..", "test_fixtures", "ledger_root");
const FIXTURE_PROJECT = "fixture-project";

// The shared contract. Mirrored in test_spend_log.py.
const EXPECTED_KNOWN_USD = 0.0059;
const EXPECTED_UNPARSED_ROWS = 3;
const EXPECTED_ENTRIES = 10;
const EXPECTED_INPUT_TOKENS = 5820;
const EXPECTED_OUTPUT_TOKENS = 238;
const EXPECTED_MALFORMED_LINES = 2;
const EXPECTED_HEADERS = 2;
const EXPECTED_TRANSLATION_SPENT = 0.00395;
const EXPECTED_EVAL_SPENT = 0.00125;
const EXPECTED_TERM_EXTRACTION_SPENT = 0.00045;
const EXPECTED_VERIFICATION_SPENT = 0.00025;
// Per account (D10). The fixture's first five records predate user_id and carry no key; the
// verification row carries an explicit null. All six are unattributed.
const HOST_A = "fixtureHostA0000000000";
const HOST_B = "fixtureHostB0000000000";
const EXPECTED_USERS = {
  [HOST_A]: { spent_usd: 0.0019, unparsed_rows: 0, entries: 2 },
  [HOST_B]: { spent_usd: 0.00045, unparsed_rows: 1, entries: 2 },
};
const EXPECTED_UNATTRIBUTED = { spent_usd: 0.00355, unparsed_rows: 2, entries: 6 };

function fixture(): SpendRecord[] {
  return load({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
}

describe("load", () => {
  it("reads every data record", () => {
    expect(fixture()).toHaveLength(EXPECTED_ENTRIES);
  });

  it("keeps the header out of the record stream", () => {
    // A consumer that summed the header into a total would double count.
    for (const record of fixture()) {
      expect((record as unknown as Record<string, unknown>)["record_type"]).not.toBe(HEADER_TYPE);
    }
  });

  it("offers the header separately", () => {
    const headers = loadHeaders({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
    expect(headers).toHaveLength(EXPECTED_HEADERS);
    expect(headers[0]?.project).toBe(FIXTURE_PROJECT);
  });

  it("RAISES for a missing ledger rather than reading it as zero", () => {
    // The single most important behavior here. "No ledger" and "spent nothing" are different
    // facts, and a budget gate that confuses them buys exactly the calls the cap prevented.
    expect(() => load({ root: FIXTURE_ROOT, project: "no-such-project" })).toThrow(LedgerNotFound);
  });

  it("returns empty only when absence is explicitly tolerated", () => {
    expect(load({ root: FIXTURE_ROOT, project: "no-such-project", missingOk: true })).toEqual([]);
  });

  it("never raises from loadHeaders for a missing ledger", () => {
    expect(loadHeaders({ root: FIXTURE_ROOT, project: "no-such-project" })).toEqual([]);
  });

  it("counts malformed lines instead of dropping them", () => {
    // A silently dropped line understates a money total. Both a non JSON line and a JSON array
    // count: neither is a record object.
    expect(malformedLines({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT })).toBe(
      EXPECTED_MALFORMED_LINES,
    );
  });
});

describe("totals", () => {
  it("matches the shared contract with the Python reader", () => {
    const summary = totals(fixture());
    expect(summary.known_usd).toBeCloseTo(EXPECTED_KNOWN_USD, 9);
    expect(summary.unparsed_rows).toBe(EXPECTED_UNPARSED_ROWS);
    expect(summary.entries).toBe(EXPECTED_ENTRIES);
    expect(summary.input_tokens).toBe(EXPECTED_INPUT_TOKENS);
    expect(summary.output_tokens).toBe(EXPECTED_OUTPUT_TOKENS);
  });

  it("excludes an unrecoverable cost from the total AND counts it as unparsed", () => {
    // The distinction that matters. Treating either of those rows as 0 would give the same
    // known_usd but a lower unparsed_rows, presenting a floor as though it were exact. Two
    // rows now: the unpriced model (cost_usd is an explicit null) and the row that omits the
    // key entirely. Absent and null have to count the same, in both readers.
    const summary = totals(fixture());
    expect(summary.unparsed_rows).toBe(EXPECTED_UNPARSED_ROWS);
    expect(summary.known_usd).toBeCloseTo(EXPECTED_KNOWN_USD, 9);
  });

  it("buckets programs separately", () => {
    const { programs } = totals(fixture());
    expect(Object.keys(programs).sort()).toEqual([
      "autopilot-eval",
      "runtime-term-extraction",
      "runtime-translation",
      "verification",
    ]);
    expect(programs["runtime-translation"]?.spent_usd).toBeCloseTo(EXPECTED_TRANSLATION_SPENT, 9);
    expect(programs["autopilot-eval"]?.spent_usd).toBeCloseTo(EXPECTED_EVAL_SPENT, 9);
    expect(programs["runtime-term-extraction"]?.spent_usd).toBeCloseTo(
      EXPECTED_TERM_EXTRACTION_SPENT,
      9,
    );
    expect(programs["verification"]?.spent_usd).toBeCloseTo(EXPECTED_VERIFICATION_SPENT, 9);
  });

  it("counts an unparsed row toward its program's entry count", () => {
    // The call still happened and still belongs to its program even though its money is
    // unknown. Dropping it from the count would hide it entirely.
    const { programs } = totals(fixture());
    expect(programs["runtime-translation"]?.entries).toBe(7);
    expect(programs["autopilot-eval"]?.entries).toBe(1);
  });

  it("leaves a known cap standing when a later row omits the key entirely", () => {
    // The absent key case against the fixture. The last runtime row BEFORE the per user rows has
    // no cap_usd at all, and both readers have to keep the 1.5 the earlier rows carried rather
    // than clearing it or throwing on undefined. The per user rows after it restate 1.5, so the
    // literal below is what still isolates the absent key.
    const { programs } = totals(fixture());
    expect(programs["runtime-translation"]?.cap_usd).toBe(1.5);
    expect(programs["autopilot-eval"]?.cap_usd).toBe(10);
  });

  it("leaves a known cap standing when the LAST row omits the key entirely", () => {
    const records = [
      { program: "p", cost_usd: 1, cap_usd: 5 },
      { program: "p", cost_usd: 1 },
    ] as unknown as SpendRecord[];
    expect(totals(records).programs["p"]?.cap_usd).toBe(5);
  });

  it("totals per account, keyed by the opaque user_id, matching the Python reader", () => {
    const { users } = totals(fixture());
    expect(Object.keys(users).sort()).toEqual([HOST_A, HOST_B]);
    for (const [id, expected] of Object.entries(EXPECTED_USERS)) {
      expect(users[id]?.spent_usd).toBeCloseTo(expected.spent_usd, 9);
      expect(users[id]?.unparsed_rows).toBe(expected.unparsed_rows);
      expect(users[id]?.entries).toBe(expected.entries);
    }
  });

  it("groups rows with no user_id, absent or null, as unattributed rather than dropping them", () => {
    // Rows from before the field existed are real spend. They must still total, and they must
    // not be charged to any account.
    const { unattributed } = totals(fixture());
    expect(unattributed.spent_usd).toBeCloseTo(EXPECTED_UNATTRIBUTED.spent_usd, 9);
    expect(unattributed.unparsed_rows).toBe(EXPECTED_UNATTRIBUTED.unparsed_rows);
    expect(unattributed.entries).toBe(EXPECTED_UNATTRIBUTED.entries);
  });

  it("adds the per account buckets and the unattributed one back up to the whole", () => {
    const summary = totals(fixture());
    const buckets = [...Object.values(summary.users), summary.unattributed];
    expect(roundMoney(buckets.reduce((t, b) => t + b.spent_usd, 0))).toBeCloseTo(
      summary.known_usd,
      9,
    );
    expect(buckets.reduce((t, b) => t + b.entries, 0)).toBe(summary.entries);
    expect(buckets.reduce((t, b) => t + b.unparsed_rows, 0)).toBe(summary.unparsed_rows);
  });

  it("totals the pre user_id rows exactly as it did before the field existed", () => {
    // The first five records are the fixture as it stood before D10. Their figures are the old
    // shared contract, unchanged: adding a field must not move a total computed without it.
    const before = totals(fixture().slice(0, 5));
    expect(before.known_usd).toBeCloseTo(0.0033, 9);
    expect(before.unparsed_rows).toBe(2);
    expect(before.entries).toBe(5);
    expect(before.users).toEqual({});
    expect(before.unattributed.entries).toBe(5);
  });

  it("totals a user_id or program that is a name every plain object already has", () => {
    // Both buckets are keyed by strings read from the ledger. In a plain {} a user_id of
    // "constructor" found Object itself, and the next line wrote a string over Object.entries,
    // which took the server down at the next view flush; "__proto__", "toString" and the rest
    // dropped their row's money from every bucket, so the buckets no longer added up.
    const names = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"];
    const summary = totals(
      names.map((name) => ({ program: name, cost_usd: 0.25, user_id: name })) as unknown as SpendRecord[],
    );
    expect(typeof Object.entries).toBe("function");
    expect(Object.keys(summary.users).sort()).toEqual([...names].sort());
    expect(Object.keys(summary.programs).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(summary.users[name]).toEqual({ spent_usd: 0.25, unparsed_rows: 0, entries: 1 });
      expect(summary.programs[name]?.spent_usd).toBe(0.25);
    }
    expect(summary.unattributed.entries).toBe(0);
  });

  it("rounds each account's total to 6 decimals, exactly", () => {
    // Exact, not toBeCloseTo: 0.1 + 0.2 is 0.30000000000000004 unrounded, which a 9 place
    // comparison accepts, so every per user assertion above passed with the rounding deleted.
    const summary = totals([
      { program: "p", cost_usd: 0.1, user_id: "someAccount" },
      { program: "p", cost_usd: 0.2, user_id: "someAccount" },
      { program: "p", cost_usd: 0.1 },
      { program: "p", cost_usd: 0.2 },
    ] as unknown as SpendRecord[]);
    expect(summary.users["someAccount"]?.spent_usd).toBe(0.3);
    expect(summary.unattributed.spent_usd).toBe(0.3);
  });

  it("counts an attributed row with no program toward its account, and still adds up", () => {
    // The account is read BEFORE the no program skip: a row's account is a separate fact from
    // its program. Every fixture row has a program, so moving the skip first went unnoticed.
    const summary = totals([
      { cost_usd: 0.25, user_id: "someAccount" },
      { program: "p", cost_usd: 0.5, user_id: "someAccount" },
    ] as unknown as SpendRecord[]);
    expect(summary.users["someAccount"]).toEqual({ spent_usd: 0.75, unparsed_rows: 0, entries: 2 });
    expect(summary.programs["p"]?.spent_usd).toBe(0.5);
    expect(summary.known_usd).toBe(0.75);
  });

  it("rounds each program's total to 6 decimals, exactly", () => {
    const summary = totals([
      { program: "p", cost_usd: 0.1 },
      { program: "p", cost_usd: 0.2 },
    ] as unknown as SpendRecord[]);
    expect(summary.programs["p"]?.spent_usd).toBe(0.3);
  });

  it("reads a program that is not a non empty string as no program, the way the Python reader does", () => {
    // A hand edited row can hold anything. Its money still counts, toward the total and its
    // account; it just has no program bucket, rather than one named "5" or "a,b".
    const summary = totals(
      [5, true, ["a", "b"], { x: 1 }, ""].map((program) => ({ program, cost_usd: 0.25, user_id: "someAccount" })) as unknown as SpendRecord[],
    );
    expect(Object.keys(summary.programs)).toEqual([]);
    expect(summary.known_usd).toBe(1.25);
    expect(summary.users["someAccount"]?.entries).toBe(5);
  });

  it("reads a corrupt user_id as unattributed rather than inventing an account", () => {
    const summary = totals([
      { program: "p", cost_usd: 1, user_id: 42 },
      { program: "p", cost_usd: 1, user_id: "" },
      { program: "p", cost_usd: 1, user_id: null },
    ] as unknown as SpendRecord[]);
    expect(summary.users).toEqual({});
    expect(summary.unattributed.entries).toBe(3);
    expect(summary.unattributed.spent_usd).toBeCloseTo(3, 9);
  });

  it("lets the last cap seen win", () => {
    // A cap raised mid program is the one in force now.
    const records = [
      { program: "p", cost_usd: 1, cap_usd: 5 },
      { program: "p", cost_usd: 1, cap_usd: 20 },
    ] as unknown as SpendRecord[];
    expect(totals(records).programs["p"]?.cap_usd).toBe(20);
  });

  it("leaves a known cap standing when a later row states none", () => {
    const records = [
      { program: "p", cost_usd: 1, cap_usd: 5 },
      { program: "p", cost_usd: 1, cap_usd: null },
    ] as unknown as SpendRecord[];
    expect(totals(records).programs["p"]?.cap_usd).toBe(5);
  });

  it("counts a record with no program toward the total but into no bucket", () => {
    const summary = totals([{ program: null, cost_usd: 2 }] as unknown as SpendRecord[]);
    expect(summary.known_usd).toBeCloseTo(2, 9);
    expect(summary.programs).toEqual({});
  });

  it("reads a non numeric cost as corrupt rather than free", () => {
    const summary = totals([
      { program: "p", cost_usd: "not a number" },
    ] as unknown as SpendRecord[]);
    expect(summary.unparsed_rows).toBe(1);
    expect(summary.known_usd).toBe(0);
  });

  it("treats no records as a true zero", () => {
    const summary = totals([]);
    expect(summary.known_usd).toBe(0);
    expect(summary.entries).toBe(0);
    expect(summary.unparsed_rows).toBe(0);
  });
});

describe("entry", () => {
  it("computes cost from the documented price", () => {
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      inputTokens: 800,
      outputTokens: 30,
    });
    expect(record.cost_usd).toBeCloseTo(0.00095, 9);
    expect(record.cost_source).toBe("logged");
  });

  it("yields a null cost and an unparsed source for an undocumented model", () => {
    // Never a guess. An omitted price is honest; an interpolated one is a lie on a spend
    // figure, which is the awws failure this rule came from.
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-undocumented-model",
      inputTokens: 500,
      outputTokens: 20,
    });
    expect(record.cost_usd).toBeNull();
    expect(record.cost_source).toBe("unparsed");
    expect(record.unit_cost_in_usd_per_mtok).toBeNull();
  });

  it("REFUSES a stated cost that contradicts its own tokens and prices", () => {
    // The harmful direction is under-logging: a cost lower than reality buys calls the cap was
    // set to prevent. So a row that disagrees with its own arithmetic is refused, not stored.
    expect(() =>
      entry({
        program: "runtime-translation",
        kind: "translation",
        model: "claude-haiku-4-5",
        inputTokens: 800,
        outputTokens: 30,
        costUsdOverride: 0.00001,
      }),
    ).toThrow(RangeError);
  });

  it("accepts a stated cost within floating point tolerance", () => {
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      inputTokens: 800,
      outputTokens: 30,
      costUsdOverride: 0.00095000001,
    });
    expect(record.cost_usd).toBeCloseTo(0.00095, 9);
  });

  it("scales its tolerance with the magnitude of the cost", () => {
    // Regression guard. An ABSOLUTE tolerance calibrated for awws (half a cent, right when one
    // unit of work is a $0.13 image) silently never fires here, where a whole call costs about
    // $0.001. The first version of this module had exactly that bug. If someone swaps the
    // relative band back for an absolute one, this test is what catches it.
    const tinyButWrong = () =>
      entry({
        program: "runtime-translation",
        kind: "translation",
        model: "claude-haiku-4-5",
        inputTokens: 800, // expected 0.00095
        outputTokens: 30,
        costUsdOverride: 0.0005, // off by ~47 percent, but only 0.00045 in absolute terms
      });
    expect(tinyButWrong).toThrow(RangeError);
  });

  it("does not write image_count, because this project renders nothing", () => {
    // It used to write a literal 0 on the theory that the dashboard needed the key present. It
    // does not: its reader is `value.is_a?(Numeric) ? value.to_i : 0`, so an absent key already
    // reads as zero. A column that can only ever hold one value is noise on every row.
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(record).not.toHaveProperty("image_count");
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty("image_count");
  });

  it("records the opaque account id it is given as user_id", () => {
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      userId: "hostAccount00000000000A",
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(record.user_id).toBe("hostAccount00000000000A");
  });

  it("writes user_id as an explicit null when the spend belongs to no account", () => {
    // Stated rather than omitted, so a new row cannot be mistaken for one that predates the field.
    const record = entry({
      program: "verification",
      kind: "verification",
      model: "claude-haiku-4-5",
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(JSON.parse(JSON.stringify(record))).toHaveProperty("user_id", null);
  });

  it("never stores a room code, only a hash the caller supplies", () => {
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      room: "a1b2c3d4e5f60718",
      inputTokens: 10,
      outputTokens: 10,
    });
    expect(record.room).toBe("a1b2c3d4e5f60718");
  });
});

describe("append and round trip", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ledger-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a record that reads back identically", () => {
    const record = entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      inputTokens: 800,
      outputTokens: 30,
      capUsd: 1.5,
      project: "round-trip",
      note: "hello",
    });
    append(record, root);

    const read = load({ root, project: "round-trip" });
    expect(read).toHaveLength(1);
    expect(read[0]).toEqual(record);
  });

  it("writes one complete line per record, so a reader splitting on newline cannot tear", () => {
    for (let i = 0; i < 5; i += 1) {
      append(
        entry({
          program: "runtime-translation",
          kind: "translation",
          model: "claude-haiku-4-5",
          inputTokens: 100,
          outputTokens: 10,
          project: "lines",
        }),
        root,
      );
    }
    const text = readFileSync(join(root, "out", "lines", "spend_log.jsonl"), "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(5);
    expect(malformedLines({ root, project: "lines" })).toBe(0);
  });
});

describe("renderMarkdown", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ledger-md-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seed(project: string, contents: string): void {
    mkdirSync(join(root, "out", project), { recursive: true });
    writeFileSync(join(root, "out", project, "spend_log.jsonl"), contents, "utf8");
  }

  it("carries the generated banner", () => {
    const text = renderMarkdown({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
    expect(text).toContain(GENERATED_BANNER);
  });

  it("prints an unrecovered cost as unknown, not as zero", () => {
    // Reading the table must not mislead. A "$0.000000" cell would read as a free call.
    const text = renderMarkdown({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
    expect(text).toContain("unknown");
  });

  it("says so when the total is a floor", () => {
    const text = renderMarkdown({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });
    expect(text).toContain("floor");
  });

  it("REFUSES to overwrite a real view from an empty ledger", () => {
    // The destructive case: writing here would replace a real record with a "$0.00" table.
    seed("empty", "");
    const target = markdownPath(root, "empty");
    writeFileSync(target, "# a real ledger view with real content\n", "utf8");

    expect(() => renderMarkdown({ root, project: "empty", write: true })).toThrow(RefusedWrite);
    expect(readFileSync(target, "utf8")).toContain("a real ledger view");
  });

  it("writes cleanly for an empty ledger with no existing view", () => {
    seed("fresh", "");
    const text = renderMarkdown({ root, project: "fresh", write: true });
    expect(text).toContain(GENERATED_BANNER);
  });

  // An ABSENT key is undefined, not null. The cost and cap cells tested `=== null`, so a row
  // that simply omits the key fell through to .toFixed() and threw a TypeError, while
  // spend_log.py routes both through _numeric() and prints "unknown" and an empty cell for
  // either shape. The two renderers therefore disagreed on a row neither the fixture nor the
  // live ledger contained, so nothing could see it.
  //
  // What made it worth fixing rather than noting: flushView swallows the throw on purpose, so
  // the server's view would silently stop regenerating while check:spend-view failed CI with a
  // message blaming a stale ledger, which points at the wrong cause entirely. The row shape
  // arrives from another writer or a hand edit, which caps.ts's own header anticipates.
  it("prints an ABSENT cost_usd as unknown rather than throwing", () => {
    seed("absent-cost", '{"program":"p","cost_source":"unparsed","note":"no cost_usd key"}\n');
    expect(renderMarkdown({ root, project: "absent-cost" })).toContain("| unknown |");
  });

  it("prints an ABSENT cap_usd as an empty cell rather than throwing", () => {
    seed(
      "absent-cap",
      '{"program":"p","cost_usd":1,"cost_source":"logged","note":"no cap_usd key"}\n',
    );
    expect(renderMarkdown({ root, project: "absent-cap" })).toContain(
      "| $1.000000 |  | no cap_usd key |",
    );
  });
});

describe("pricing", () => {
  it("returns null for an undocumented model rather than guessing", () => {
    expect(priceFor("claude-undocumented-model")).toBeNull();
    expect(costUsd("claude-undocumented-model", 1000, 100)).toBeNull();
  });

  it("carries a source for every documented price", () => {
    // A price with no citable source does not belong in the table at all.
    const price = priceFor("claude-haiku-4-5");
    expect(price?.source).toBeTruthy();
  });

  it("rounds to six decimals, matching spend_log.py and the dashboard's Ruby reader", () => {
    expect(roundMoney(0.15119999999999997)).toBe(0.1512);
  });
});

describe("ledgerWritable", () => {
  // The bug this exists for: the Dockerfile did COPY out/ out/ as root and then switched to
  // USER node, so appendFileSync failed EACCES for the whole life of the container. record()
  // caught it, logged, and let the call proceed on the reasoning that "the next cap check will
  // refuse anyway". It does not. SpendGate.check refuses only on LedgerNotFound, and the baked in
  // file still exists and still parses, so the gate kept reading a stale ledger and kept allowing
  // calls. Spend continued, permanently untracked, behind one warning line per call.
  it("says yes for a ledger it can append to", () => {
    const root = mkdtempSync(join(tmpdir(), "writable-"));
    mkdirSync(join(root, "out", PROJECT_SLUG), { recursive: true });
    writeFileSync(ledgerPath(root), "", "utf8");
    expect(ledgerWritable(root)).toEqual({ ok: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("says no, with a reason, for a read only ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "readonly-"));
    mkdirSync(join(root, "out", PROJECT_SLUG), { recursive: true });
    const path = ledgerPath(root);
    writeFileSync(path, "", "utf8");
    chmodSync(path, 0o444);

    const verdict = ledgerWritable(root);
    // Running as root defeats file permissions entirely, so skip rather than assert something
    // false. The check still runs for everyone else, including CI.
    if (process.getuid?.() !== 0) {
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toMatch(/EACCES|permission/i);
    }
    chmodSync(path, 0o644);
    rmSync(root, { recursive: true, force: true });
  });

  it("says no when the ledger is not there at all", () => {
    const root = mkdtempSync(join(tmpdir(), "missing-"));
    expect(ledgerWritable(root).ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT create a missing ledger just by asking", () => {
    // The honesty rule, in its most dangerous form. load() raises for a missing ledger because
    // "no ledger" and "spent nothing" are different facts. A probe that created the file to test
    // writability would convert the first into the second silently, and hand the cap gate an
    // empty ledger to spend against. The directory exists here, so only the file is in question.
    const root = mkdtempSync(join(tmpdir(), "nocreate-"));
    mkdirSync(join(root, "out", PROJECT_SLUG), { recursive: true });
    const path = ledgerPath(root);

    const verdict = ledgerWritable(root);

    expect(existsSync(path)).toBe(false);
    expect(verdict.ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("appends nothing, so probing cannot pollute the ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "probe-"));
    mkdirSync(join(root, "out", PROJECT_SLUG), { recursive: true });
    const path = ledgerPath(root);
    writeFileSync(path, '{"record_type":"header","project":"x"}\n', "utf8");
    const before = readFileSync(path, "utf8");

    ledgerWritable(root);

    expect(readFileSync(path, "utf8")).toBe(before);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("the generated view keeps up with the ledger", () => {
  // It did not, and that is why this exists. spend_log.md was written once at the scaffold commit
  // and never regenerated, so the committed view read "Known spend $0.0000 across 0 calls" while
  // the ledger beside it held 111 calls and $0.063896. A human reading the view concluded nothing
  // had been spent. RefusedWrite cannot catch this: it guards the opposite direction, an empty
  // ledger overwriting a real view.
  //
  // The trigger is a slow flush, NOT the append. Rendering per append reads and rewrites the
  // whole ledger synchronously on the paid call path: 133ms of frozen event loop at 10k rows,
  // and worse forever after.
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "view-"));
    mkdirSync(join(root, "out", PROJECT_SLUG), { recursive: true });
    writeFileSync(ledgerPath(root), "", "utf8");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function record(inputTokens: number) {
    return entry({
      program: "runtime-translation",
      kind: "translation",
      model: "claude-haiku-4-5",
      inputTokens,
      outputTokens: 10,
    });
  }

  it("does no rendering work on the append itself", () => {
    // The whole point of the revert. An append marks the view stale and writes one line.
    append(record(800), root);
    expect(existsSync(markdownPath(root))).toBe(false);
    expect(viewIsStale(root)).toBe(true);
  });

  it("agrees with the ledger once flushed", () => {
    for (const tokens of [800, 900, 1000]) append(record(tokens), root);
    expect(flushView(root)).toBe(true);

    const summary = totals(load({ root }));
    const view = readFileSync(markdownPath(root), "utf8");
    expect(view).toContain(`across ${summary.entries} calls`);
    expect(view).toContain(`$${summary.known_usd.toFixed(4)}`);
    expect(view).not.toContain("$0.0000 across 0 calls");
  });

  it("does nothing when no row has landed since the last flush", () => {
    append(record(800), root);
    expect(flushView(root)).toBe(true);
    // Idle servers must not rewrite a large file on every tick of the timer.
    expect(flushView(root)).toBe(false);
  });

  it("stays stale when the view cannot be written, so the next flush retries", () => {
    append(record(800), root);
    const before = readFileSync(ledgerPath(root), "utf8");

    // A directory where the markdown belongs: writing it throws.
    mkdirSync(markdownPath(root));
    expect(flushView(root)).toBe(false);
    expect(viewIsStale(root)).toBe(true);

    // And the ledger itself is untouched by any of it. An unwritten row is untracked spend; an
    // unwritten view is a stale document, and they must never share a failure mode.
    expect(() => append(record(900), root)).not.toThrow();
    expect(readFileSync(ledgerPath(root), "utf8").length).toBeGreaterThan(before.length);
  });
});

describe("parity with the Python renderer", () => {
  // This is the ONE test in either suite that runs both renderers and compares their output.
  // Before it existed, ledger.test.ts and test_spend_log.py each asserted their own expected
  // numbers against test_fixtures/ledger_root in parallel: a shared INPUT, not a shared proof.
  // Neither suite ever invoked the other language's implementation, so a spacing or number
  // formatting drift between the two would have passed both suites while
  // script/check_spend_view.mjs, which diffs a TypeScript-written view against a Python-rendered
  // one in production, would start failing on every run with a message that blames a stale
  // ledger rather than the actual cause.
  //
  // Spawns the real CLI entry point, `python3 spend_log.py render`, rather than importing
  // spend_log as a library, so this exercises exactly the code path check_spend_view.mjs runs.
  it("renders byte identical output to spend_log.py render for the same fixture ledger", () => {
    const tsOutput = renderMarkdown({ root: FIXTURE_ROOT, project: FIXTURE_PROJECT });

    const python = spawnSync(
      "python3",
      [join(REPO_ROOT, "spend_log.py"), "render", FIXTURE_PROJECT, "--root", FIXTURE_ROOT],
      { encoding: "utf8" },
    );

    expect(python.status).toBe(0);

    // Confirmed by hand: render_markdown() in spend_log.py returns a string ending in exactly
    // one newline, same as renderMarkdown() here. The CLI's `render` subcommand then does
    // print(text), which appends a second newline on top of the one already inside the string.
    // renderMarkdown()'s return value here goes through no such wrapper, so it carries only the
    // one embedded newline. The claim under test is "identical modulo that one documented
    // print() newline", not "identical strings", so the expectation says so rather than
    // trimming both sides and hiding what the difference actually is.
    expect(python.stdout).toBe(`${tsOutput}\n`);
  });
});
