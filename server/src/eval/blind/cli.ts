// `npm run blind`: the blind model comparison, start to finish, in one command.
//
//   npm run blind -- --limit 10            a balanced 10 item smoke run, 2 per target
//   npm run blind                          the full set
//   npm run blind -- --run-id <id>         resume a run: skips everything already recorded
//   npm run blind -- --dry-run --limit 10  the whole pipeline against a fake client and a
//                                          temporary ledger: no key, no network, no money
//
// Flags: --budget-usd (default 6.00, the run's hard total), --judge-budget-usd (default 4.00, the
// judge's share, still inside the total), --no-judge. Exit codes: 0 finished, 3 finished early (a
// budget stop or an arm switched off; the files are written and say so), 1 refused or failed.
//
// The key is checked for PRESENCE only and is never printed, logged or passed anywhere but the SDK
// client, exactly as script/verify_translation.mjs does it.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewIsStale } from "../../spend/ledger.js";
import { createAnthropicClient } from "../../translate/anthropic.js";
import { fakeClient } from "./fake.js";
import { parseItems } from "./items.js";
import { writeReports } from "./report.js";
import {
  BlindRefusal,
  BlindRun,
  DEFAULT_BUDGET_USD,
  DEFAULT_JUDGE_BUDGET_USD,
  readJsonl,
  sha256,
  type JudgeRecord,
  type OutputRecord,
  type RunDeps,
} from "./runner.js";

export interface CliOptions {
  dryRun: boolean;
  limit: number | null;
  runId: string | null;
  budgetUsd: number;
  judgeBudgetUsd: number;
  judge: boolean;
}

function amount(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed <= 0) throw new BlindRefusal(`${flag} needs a positive amount of US dollars`);
  return parsed;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    dryRun: false,
    limit: null,
    runId: null,
    budgetUsd: DEFAULT_BUDGET_USD,
    judgeBudgetUsd: DEFAULT_JUDGE_BUDGET_USD,
    judge: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    const [name, inline] = flag.includes("=") ? [flag.slice(0, flag.indexOf("=")), flag.slice(flag.indexOf("=") + 1)] : [flag, undefined];
    const value = () => inline ?? argv[(i += 1)];
    switch (name) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--judge":
        options.judge = true;
        break;
      case "--no-judge":
        options.judge = false;
        break;
      case "--limit": {
        const raw = value();
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) throw new BlindRefusal("--limit needs a whole number of items");
        options.limit = n;
        break;
      }
      case "--run-id": {
        const raw = value();
        if (raw === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new BlindRefusal("--run-id takes letters, digits, - and _ only");
        options.runId = raw;
        break;
      }
      case "--budget-usd":
        options.budgetUsd = amount(name, value());
        break;
      case "--judge-budget-usd":
        options.judgeBudgetUsd = amount(name, value());
        break;
      default:
        throw new BlindRefusal(`unknown flag ${flag}`);
    }
  }
  return options;
}

export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
}

export interface Io {
  log: (line: string) => void;
  error: (line: string) => void;
  repoRoot: string;
  /** Install signal handlers that log calls in flight before exiting. The script does; tests do not. */
  signals?: boolean;
  /** Stands in for the network in a test of the real path. Unset: the real API. */
  clientFor?: RunDeps["clientFor"];
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.error(`blind: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const apiKey = env["ANTHROPIC_API_KEY"];
  if (!options.dryRun && !apiKey) {
    io.error("ANTHROPIC_API_KEY is not set. This run makes REAL API calls and cannot start without it.");
    io.error("To exercise the whole pipeline for free: npm run blind -- --dry-run --limit 10");
    return 1;
  }

  const setPath = join(io.repoRoot, "eval", "blind", "sentences.jsonl");
  const setText = readFileSync(setPath, "utf8");
  const items = parseItems(setText);
  const runId = options.runId ?? `${options.dryRun ? "dry-" : ""}${newRunId()}`;

  // A dry run gets a temporary root holding an empty ledger: the real ledger is never touched.
  let root = io.repoRoot;
  if (options.dryRun) {
    root = mkdtempSync(join(tmpdir(), "translatv-blind-"));
    mkdirSync(join(root, "out", "translatv"), { recursive: true });
    writeFileSync(join(root, "out", "translatv", "spend_log.jsonl"), "", "utf8");
  }
  const runDir = join(root, "out", "translatv", "blind", runId);

  const clientFor: RunDeps["clientFor"] =
    io.clientFor ?? (options.dryRun ? fakeClient : (model, profile) => createAnthropicClient(apiKey!, { model, profile }));
  const run = new BlindRun(
    {
      root,
      runId,
      runDir,
      items,
      setSha256: sha256(setText),
      limit: options.limit,
      budgetUsd: options.budgetUsd,
      judgeBudgetUsd: options.judgeBudgetUsd,
      judge: options.judge,
      dryRun: options.dryRun,
    },
    { clientFor, log: io.log },
  );

  const flush = () => {
    if (run.flushView()) io.log("Regenerated out/translatv/spend_log.md from the ledger. Commit it with the ledger rows.");
    else if (viewIsStale(root)) io.error("WARNING: ledger rows were appended but spend_log.md could not be regenerated.");
  };

  if (io.signals) {
    for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
      process.on(signal, () => {
        io.error(`${signal} received. Logging calls in flight at their worst case before exiting.`);
        const abandoned = run.abandonInFlight();
        if (abandoned > 0) io.error(`Logged ${abandoned} call(s) still running as unknown, at their worst case.`);
        flush();
        process.exit(code);
      });
    }
  }

  io.log(`blind run ${runId}${options.dryRun ? " (dry run: fake client, temporary ledger)" : ""}`);
  io.log(`budget $${options.budgetUsd.toFixed(2)} in all, judge $${options.judgeBudgetUsd.toFixed(2)}${options.judge ? "" : " (judge off)"}`);
  let code = 0;
  let summary;
  try {
    summary = await run.execute();
  } catch (error) {
    io.error(`blind: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  }

  // Reports are written from the files, whatever happened, unless the run never got started.
  if (!(summary === undefined && code === 1 && readJsonl<OutputRecord>(run.outputsPath).length === 0)) {
    try {
      writeReports(runDir, {
        runId,
        seed: run.seedValue,
        root,
        runRoom: run.runRoom,
        items,
        selected: run.selected(),
        outputs: new Map(readJsonl<OutputRecord>(run.outputsPath).map((r) => [`${r.item}:${r.arm}`, r])),
        judged: new Map(readJsonl<JudgeRecord>(run.judgePath).map((r) => [r.item, r])),
        budgetUsd: options.budgetUsd,
        judgeBudgetUsd: options.judgeBudgetUsd,
        judgeEnabled: options.judge,
        stops: summary?.stops ?? [],
        disabled: summary?.disabled ?? {},
        dryRun: options.dryRun,
      });
      io.log(`wrote ${runDir}/report.md, rating_sheet.csv, key.json`);
    } catch (error) {
      io.error(`blind: the reports could not be written: ${error instanceof Error ? error.message : String(error)}`);
      code = 1;
    }
  }
  flush();

  if (summary !== undefined) {
    io.log(`${summary.translationsRecorded} translations recorded and ${summary.judged} items judged, of ${summary.selected} items.`);
    if (summary.stops.length > 0 || Object.keys(summary.disabled).length > 0) {
      io.log(`Finished EARLY. Resume with: npm run blind -- --run-id ${runId}${options.limit === null ? "" : ` --limit ${options.limit}`}`);
      code = 3;
    }
  }
  if (options.dryRun) io.log(`dry run files are in ${root}`);
  return code;
}
