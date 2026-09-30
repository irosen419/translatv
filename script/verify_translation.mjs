#!/usr/bin/env node
// Verify REAL translation against the live Anthropic API. This is autopilot step vt-0005.
//
// Everything else in this repo is tested against an injected fake, which is what keeps the test
// suite free and offline. The cost of that choice is that the feature's whole reason for
// existing has never been observed: does es-AR actually produce voseo rather than tu forms?
// A fake cannot answer that. This script can, and it is the only thing here that spends money.
//
// It scores the dialect markers automatically rather than asking a human to eyeball output,
// because "looks Spanish to me" is not a check. es-AR must produce tenes and never tienes;
// es-ES must produce vosotros; es-CO must produce usted. Those are falsifiable.
//
//   npm run verify
//
// Via tsx, NOT bare node: this file imports .ts modules whose constructor parameter properties
// Node's own type stripping refuses (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). `node script/...` was
// documented here and in TESTING.md and has never worked.
//
// Roughly 25 calls at about $0.001 each. Every one is appended to the REAL ledger at
// out/translatv/spend_log.jsonl under the "verification" program, so the spend is
// tracked and is kept out of the runtime cost per call figure at the same time.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

// The key is checked for PRESENCE only and never printed, logged, or passed anywhere but the
// SDK client. A verification script that leaks the credential it verifies is worse than none.
if (!process.env["ANTHROPIC_API_KEY"]) {
  console.error("ANTHROPIC_API_KEY is not set.\n");
  console.error("This script makes REAL API calls and cannot run without it. Everything else");
  console.error("in the repo runs against a fake client and stays free:");
  console.error("  npm run check   # 223 tests, no network");
  console.error("  npm run e2e     # two browsers, translation deliberately off");
  process.exit(1);
}

const { TranslationService } = await import(`${REPO}/server/src/translate/TranslationService.ts`);
const { createAnthropicClient } = await import(`${REPO}/server/src/translate/anthropic.ts`);
const { PROGRAMS, SpendGate, roomHash } = await import(`${REPO}/server/src/spend/caps.ts`);
const { LedgerNotFound, flushView, ledgerWritable, load, totals, viewIsStale } = await import(
  `${REPO}/server/src/spend/ledger.ts`,
);

let failures = 0;
let checks = 0;
/**
 * Every TranslationService this run makes. A call still running when the script exits (one past
 * its timeout, say) would cost something the ledger never hears of, so each exit logs them first
 * (flushViewNow). Declared up here because the signal handlers can run before the services exist.
 */
const services = [];

function check(label, ok, detail = "") {
  checks += 1;
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/**
 * Regenerate the committed view, and say so.
 *
 * Called from every exit path as well as from the finally, because process.exit() is NOT an
 * exception: it terminates immediately and finally blocks do not run. Putting the flush only in
 * the finally therefore skipped it on precisely the paths that had already written rows, which is
 * how the stale view blocker came back through the door the budget stop exit opened.
 *
 * Safe to call more than once: flushView is a no op when nothing is stale.
 */
function flushViewNow() {
  for (const service of services) {
    const abandoned = service.abandonInFlight();
    if (abandoned > 0) console.error(`Logged ${abandoned} call(s) still running as unknown, at their worst case.`);
  }
  if (flushView(root)) {
    console.log("\nRegenerated out/translatv/spend_log.md to match the ledger.");
    console.log("COMMIT BOTH: the ledger rows and the view are one change.");
    return;
  }
  // Only reachable when nothing was stale, or when the write FAILED: flushView swallows its own
  // throw by design and returns false either way. A read only view or a full disk would otherwise
  // leave rows written, the view stale, and nothing said about it.
  if (viewIsStale(root)) {
    console.error("\nWARNING: rows were appended but the view could NOT be regenerated.");
    console.error("The likely cause is that out/translatv/spend_log.md is not writable,");
    console.error("in which case `python3 spend_log.py render --execute` will fail the same way.");
    console.error("Fix that first. Until the view is regenerated npm run check fails on the");
    console.error("spend view gate, and the ledger rows themselves are already safely written.");
  }
}

/**
 * The REPO's ledger, not a temporary one.
 *
 * This used to mkdtemp a root, write an empty ledger into it, and rmSync the whole thing in a
 * finally, while the header above claimed "every one goes through the real ledger". It did not:
 * about $0.025 of real money was recorded into a directory that was then deleted. Untracked spend
 * is the single failure this project exists to prevent, and it was living inside the one script
 * that spends, under a comment asserting the opposite.
 *
 * Isolation was the right instinct and the wrong mechanism. What actually needs separating is the
 * COLUMN, not the file: these are about 25 calls of contrived probe text, and booking them as
 * runtime-translation would move the runtime cost per call figure. That is what the `verification`
 * program is for, and it is the same reasoning HANDOFF-APP.md section 4 applies to benchmark
 * spend. The money is real, so the row is real, and it goes where every other row goes.
 */
const root = REPO;

// Caps for THIS run, deliberately tighter than the project's own ($10.00 a day, $1.50 a room).
// A verification pass should never be the thing that exhausts a real budget, and the gate reads
// the real ledger now, so a day that has already spent heavily correctly refuses this.
//
// The two numbers do different jobs, which is worth naming because the room one reads as a
// redundant smaller copy of the daily one and is not.
//
// The DAILY cap is the live ceiling. SpendGate.check sums every row on the ledger for the UTC
// day with no program filter, so runtime translation and the nightly eval count against this run
// as well. At about $0.000563 a call, measured over the ledger's first 136 real rows, $1.00 is
// 40 to 70 runs of this script, which nobody will do, or a few hours of real conversation on the
// same day, which is plausible. So the realistic way this fires is that something else already
// spent the dollar and verification is refused having spent nothing. That is the safe direction
// to fail, and it is not the same thing as the app being out of budget: $1.00 here is a tenth of
// the app's own daily cap.
//
// The ROOM cap cannot fire the way a runtime room cap does, because ROOM below is per run, so
// one room hash only ever holds one run of about 25 calls, a quarter of even this tighter number.
// What it is instead is the runaway backstop INSIDE a single run, the only ceiling that would
// stop a stuck retry loop before the daily budget absorbed it. At $0.10 it bites near 180 calls,
// seven times the intended workload. It was $0.50, which allowed about 890 calls in a run that
// intends 25, so it was a number that could not realistically stop anything (owner decision,
// 2026-08-05).
const gate = new SpendGate(root, { dailyCapUsd: 1.0, roomCapUsd: 0.1 });

// Fail like everything else if there is no ledger. load() raising for a missing ledger is the
// honesty rule working, but raising it out here, before the try below, produced a bare stack
// trace with no FATAL line and no check summary.
try {
  load({ root });
} catch (error) {
  console.error(`\nFATAL: ${error?.message ?? error}`);
  if (error instanceof LedgerNotFound) {
    console.error("There is no ledger to record this run's spend into, and spending against a cap");
    console.error("that cannot be read is the failure the cap exists to prevent. Create");
    console.error("out/translatv/spend_log.jsonl first.");
  } else {
    console.error("The ledger exists but could not be read. Fix that before spending: a cap");
    console.error("derived from a ledger nobody can read is not a cap.");
  }
  process.exit(1);
}

// Can it be APPENDED to, not merely read? Different question, and index.ts asks it at boot for
// exactly this reason. Without it, a read only ledger lets every call go through while every
// append fails: the service latches off after LEDGER_FAILURE_LIMIT, but only after about three
// paid calls have happened with nothing recording them. Untracked spend is the one thing this
// script exists not to do.
const writable = ledgerWritable(root);
if (!writable.ok) {
  console.error(`\nFATAL: the spend ledger cannot be written: ${writable.reason}`);
  console.error("Every call would be real money with no row to show for it. Fix the file's");
  console.error("permissions and re-run.");
  process.exit(1);
}

// A signal skips the finally for the same reason process.exit does, and Ctrl+C is a realistic
// thing to do to a script that prints translations for a minute or more. Rows already appended
// are real money, so the view has to describe them however the run ends.
//
// Registered here rather than beside flushViewNow because it closes over `root`, which is
// declared above this point and would be in its temporal dead zone earlier.
// SIGHUP included: closing the terminal or dropping an ssh session mid run leaves exactly the
// stale view these handlers exist to prevent. Codes are the shell convention, 128 plus the
// signal number.
for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    console.error(`\n${signal} received. Regenerating the view before exiting.`);
    flushViewNow();
    process.exit(code);
  });
}
const service = new TranslationService(
  createAnthropicClient(process.env["ANTHROPIC_API_KEY"]),
  gate,
  root,
);
services.push(service);

// Per RUN, not a constant.
//
// roomSpentUsd in SpendGate.check has no day filter and the ledger is append only, so a fixed
// room code accumulates forever: at about $0.024 a run against the $0.10 room cap, run 5 dies
// partway, run 6 refuses at the smoke call, and every run after it does too, with no legal
// remedy because deleting rows is forbidden. Tightening the cap to $0.10 moves that failure
// closer rather than removing it, so it is a reason to scope the room here and not an argument
// against scoping it. One run per room is what lets the cap be a ceiling on THIS pass instead of
// a slowly closing door on every future one.
const RUN_ID = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
const ROOM = roomHash(`VERIFY-${RUN_ID}`);

async function translate(text, targetDialect, glossary = []) {
  return service.translate({
    lineId: `V${Math.round(performance.now())}`,
    text,
    sourceDialect: "en-US",
    targetDialect,
    context: [],
    glossary,
    roomHash: ROOM,
    kind: "verification",
  });
}

// Strip accents before matching, so "tenés" and "tenes" both count as voseo. The dialect
// markers are about grammar, not orthography, and the model is free to accent correctly.
const normalize = (s) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Whole word match, so "ten" does not match inside "tienes". */
const hasWord = (text, word) => new RegExp(`\\b${word}\\b`).test(normalize(text));

try {
  // ---------------------------------------------------------------------
  section("1. Smoke call: is the model id, temperature, and call shape accepted?");
  // Deliberately alone and first. This is where a first real call actually fails, and finding
  // out via one cheap request beats discovering it 20 calls into a dialect matrix.
  const smoke = await translate("hello", "es-MX");
  check("a real API call succeeds", smoke.ok, smoke.ok ? "" : smoke.message);
  if (smoke.ok) {
    console.log(`        "hello" -> "${smoke.text}"`);
    check("the model reported real token usage", smoke.inputTokens > 0 && smoke.outputTokens > 0);
  } else {
    console.error("\nThe first real call failed. Everything below depends on it, so stopping.");
    console.error(`Reason: ${smoke.message}`);
    if (!smoke.retriable) {
      console.error("This is a TERMINAL failure: retrying will not help. Fix the config first.");
    }
    // Flush before exiting: a row can already be on disk here. TranslationService.execute calls
    // record() BEFORE its empty text check, so a model returning nothing appends a row and then
    // reports ok:false straight into this branch.
    flushViewNow();
    process.exit(1);
  }

  // ---------------------------------------------------------------------
  section("2. Dialect fidelity: the actual open question");
  //
  // This is what the whole project is for. DeepL and Google Translate essentially cannot be told
  // to produce voseo; an LLM can, because it is a prompt parameter. If this section fails, the
  // premise of the product is wrong and no amount of polish elsewhere matters.
  const DIALECTS = [
    {
      code: "es-AR",
      label: "Argentina (voseo)",
      sentences: ["do you have time tomorrow", "you are right", "come whenever you want"],
      // Rioplatense: vos tenes / vos sos / veni. Never the tu forms.
      want: ["tenes", "sos", "veni", "vos", "tenés", "querés"],
      reject: ["tienes", "vosotros", "tuvieres"],
    },
    {
      code: "es-ES",
      label: "Spain (vosotros)",
      sentences: ["do you all want to come", "you all have time"],
      want: ["vosotros", "quereis", "teneis", "queréis", "tenéis"],
      reject: ["ustedes"],
    },
    {
      code: "es-CO",
      label: "Colombia (usted)",
      sentences: ["do you have time tomorrow", "you are right"],
      want: ["usted", "tiene", "venga"],
      reject: ["vosotros"],
    },
    {
      code: "es-MX",
      label: "Mexico (tu, never vosotros)",
      sentences: ["do you have time tomorrow", "do you all want to come"],
      want: ["tienes", "ustedes", "tu", "tú"],
      reject: ["vosotros", "tenes"],
    },
  ];

  for (const dialect of DIALECTS) {
    console.log(`\n  ${dialect.label}`);
    let sawWanted = false;
    let sawRejected = null;

    for (const sentence of dialect.sentences) {
      const result = await translate(sentence, dialect.code);
      if (!result.ok) {
        // A budget stop is not a translation failure, and letting it fall through to the register
        // check below reports "es-AR produces its own register FAIL" for a call that never
        // happened. Section 2's own comment says that failing means the premise of the product is
        // wrong, so it must not be reachable by running out of money.
        if (result.status === "budget_exceeded") {
          console.error(`\nSTOPPING: the budget refused a call mid matrix. ${result.message}`);
          console.error("This is a spend stop, NOT a dialect failure. Nothing below was measured.");
          console.error("Raise the caps in this script or wait for the daily window, then re-run.");
          // Reaching section 2 means the smoke call succeeded, so rows are ALWAYS on disk here.
          flushViewNow();
          process.exit(1);
        }
        check(`${dialect.code}: "${sentence}"`, false, result.message);
        continue;
      }
      console.log(`        "${sentence}"\n          -> "${result.text}"`);
      if (dialect.want.some((w) => hasWord(result.text, normalize(w)))) sawWanted = true;
      const bad = dialect.reject.find((w) => hasWord(result.text, normalize(w)));
      if (bad) sawRejected = `${bad}  (in: ${result.text})`;
    }

    check(
      `${dialect.code} produces its own register`,
      sawWanted,
      sawWanted ? "" : `none of ${dialect.want.join(", ")} appeared`,
    );
    check(
      `${dialect.code} avoids the wrong register`,
      sawRejected === null,
      sawRejected ?? "",
    );
  }

  // ---------------------------------------------------------------------
  section("3. Glossary adherence: does a correction actually stick?");
  const withoutGlossary = await translate("the standup is at nine", "es-AR");
  const withGlossary = await translate("the standup is at nine", "es-AR", [
    { source: "standup", target: "la daily", sourceDialect: "en-US", targetDialect: "es-AR" },
  ]);

  if (withoutGlossary.ok) console.log(`        without: "${withoutGlossary.text}"`);
  if (withGlossary.ok) console.log(`        with:    "${withGlossary.text}"`);
  check(
    "a glossary entry changes the translation",
    withGlossary.ok && /daily/i.test(withGlossary.text),
    withGlossary.ok ? `glossary term absent from: ${withGlossary.text}` : "call failed",
  );

  // ---------------------------------------------------------------------
  section("4. Ledger truth: does the recorded spend match reality?");
  // Filtered, not sliced by position. A dev server translating in another terminal appends
  // runtime rows into the same file, and positional slicing would pull those in: the room
  // assertion below would then fail under a label about leaked room codes when nothing leaked,
  // and the cost per hour figure would over report. The verification program exists precisely so
  // this run's rows are identifiable by what they are.
  const records = load({ root }).filter(
    (r) => r.program === PROGRAMS.verification && r.room === ROOM,
  );
  check("one ledger row per successful call", records.length >= 10, `${records.length} rows`);
  check(
    "every row has real token counts",
    records.every((r) => (r.input_tokens ?? 0) > 0 && (r.output_tokens ?? 0) > 0),
  );
  check(
    "every row has a recovered cost, none unparsed",
    records.every((r) => typeof r.cost_usd === "number"),
  );
  check(
    "no row contains a room code or transcript text",
    records.every((r) => r.room === ROOM) &&
      !JSON.stringify(records).includes("do you have time tomorrow"),
  );

  const summary = totals(records);
  const arithmetic = records.reduce(
    (sum, r) => sum + ((r.input_tokens ?? 0) / 1e6) * 1.0 + ((r.output_tokens ?? 0) / 1e6) * 5.0,
    0,
  );
  check(
    "the ledger total matches the token arithmetic",
    Math.abs(summary.known_usd - arithmetic) < 1e-6,
    `ledger ${summary.known_usd} vs computed ${arithmetic.toFixed(6)}`,
  );

  // The two readers must agree to the last decimal, or a figure on the dashboard and one from
  // the CLI would differ in the tail and send someone hunting a discrepancy that is not real.
  //
  // Compared over the WHOLE ledger, not over this run's slice. Python has no notion of where this
  // run started, and asking it to agree with a subset would either need that offset plumbed
  // through or would silently compare two different populations. The whole file is also the
  // stronger assertion: it covers every row the project has ever written, not just the fresh ones.
  const wholeLedger = totals(load({ root }));
  const py = spawnSync(
    "python3",
    ["-c", `import sys; sys.path.insert(0,"${REPO}"); import spend_log;` +
      ` r=spend_log.load("translatv", root="${root}");` +
      ` print("%.6f" % spend_log.totals(r)["known_usd"])`],
    { encoding: "utf8" },
  );
  const pythonRaw = (py.stdout || "").trim();
  const pythonTotal = Number(pythonRaw);
  check(
    "the Python reader actually ran",
    py.status === 0 && pythonRaw.length > 0 && Number.isFinite(pythonTotal),
    `python3 exited ${py.status}, stdout ${JSON.stringify(pythonRaw)}, stderr ${JSON.stringify((py.stderr || "").trim().slice(0, 200))}`,
  );
  check(
    "the Python and TypeScript readers agree exactly, over the whole ledger",
    Math.abs(pythonTotal - wholeLedger.known_usd) < 1e-9,
    `python ${pythonTotal} vs typescript ${wholeLedger.known_usd}`,
  );

  // ---------------------------------------------------------------------
  section("5. Cap enforcement against real recorded spend");
  // The daily cap is deliberately unreachable. SpendGate.check tests daily BEFORE room, so a
  // tightGate carrying a real daily cap refuses with reason "daily_cap" on any day that already
  // has spend, and this check goes green having tested nothing about the room cap it names.
  const tightGate = new SpendGate(root, { dailyCapUsd: 1e9, roomCapUsd: 0.0001 });
  const capped = new TranslationService(
    createAnthropicClient(process.env["ANTHROPIC_API_KEY"]),
    tightGate,
    root,
  );
  services.push(capped);
  const refused = await capped.translate({
    lineId: "CAP",
    text: "this must not be translated",
    sourceDialect: "en-US",
    targetDialect: "es-AR",
    context: [],
    glossary: [],
    roomHash: ROOM,
    kind: "verification",
  });
  check(
    "a breached room cap refuses BEFORE spending",
    !refused.ok && refused.status === "budget_exceeded",
    refused.ok ? "the call went through anyway" : refused.message,
  );

  // ---------------------------------------------------------------------
  section("What it cost");
  console.log(`  ${records.length} calls, $${summary.known_usd.toFixed(6)}`);
  console.log(`  ${summary.input_tokens} input tokens, ${summary.output_tokens} output tokens`);
  const perHour = (summary.known_usd / records.length) * 8 * 60;
  console.log(`  implies about $${perHour.toFixed(2)} per hour of conversation at 8 turns/min`);
} catch (error) {
  failures += 1;
  console.error(`\nFATAL: ${error?.message ?? error}`);
} finally {
  // Covers the throw paths. The exit paths call this themselves, above, because finally does not
  // run on process.exit.
  flushViewNow();
}

// No cleanup. The rows just written are real spend and stay in the real ledger; the previous
// version deleted its root here, which with the repo as root would delete the repository.

console.log(`\n${checks - failures} of ${checks} checks passed.`);
process.exit(failures === 0 ? 0 : 1);
