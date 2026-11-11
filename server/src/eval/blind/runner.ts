// The blind test's run: every translation first, then the judge, then the files a person reads.
//
// The spend rules are CLAUDE.md's, applied to a batch:
//
//   Every call that returns is appended to the ledger, under the blind-test program and the run's
//     room hash, BEFORE its result is used: before its line in outputs.jsonl, before anything reads
//     its text. A request that was sent and lost its answer (the adapter's onLost: a dropped
//     connection, a timeout's abort) is appended at its worst case the moment it is reported,
//     computed exactly as production computes it (requestWorstCaseUsd).
//   Calls run concurrently, bounded by MAX_CONCURRENT, and every call first reserves its worst case
//     against the run budget (RunBudget), which is read off the ledger. A refused reservation stops
//     the phase cleanly: nothing more is started, what is in flight finishes and is recorded.
//   A ledger append that fails stops the run at once. Spending on with rows unwritten is the one
//     failure this repository exists to prevent.
//   Calls still in flight when the process is told to stop are appended at their worst case and
//     aborted (abandonInFlight), as verify_translation.mjs does.
//
// Resumable: outputs.jsonl and judge.jsonl are appended as results arrive, and a rerun with the
// same run id skips everything already recorded with an outcome. A call that failed for a reason
// worth retrying (a rate limit, a server error, a lost connection) is recorded as an error and is
// tried again on the next pass or the next run, so a crash never pays twice for an answer it has.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dialectByCode } from "@translatv/shared";
import { PROGRAMS, roomHash } from "../../spend/caps.js";
import { append, entry, flushView, LedgerNotFound, ledgerWritable, load } from "../../spend/ledger.js";
import { MAX_RETRIES, type RequestProfile } from "../../translate/anthropic.js";
import { buildSystemPrompt, buildUserMessage } from "../../translate/prompt.js";
import { LlmFailure, requestWorstCaseUsd, type LlmClient } from "../../translate/TranslationService.js";
import { ARMS, buildJudgeMessage, JUDGE_MODEL, JUDGE_PROFILE, JUDGE_SYSTEM, parseJudgement, type ArmId, type Rating } from "./arms.js";
import { RunBudget } from "./budget.js";
import { contextFor, interleaveByTarget, selectBalanced, type BlindItem } from "./items.js";
import { rng, seedFrom, shuffled } from "./stats.js";

/** Calls in flight together, across all arms and the judge. The bound CLAUDE.md requires. */
export const MAX_CONCURRENT = 4;
/** A call not answered in this long is aborted, and its request logged at its worst case. */
export const CALL_TIMEOUT_MS = 180_000;
/** No request (the adapter's one retry included) is started later than this after the call began. */
export const SEND_WINDOW_MS = 60_000;
/** Passes over the translations: the second retries what failed for a reason worth retrying. */
export const TRANSLATION_PASSES = 2;

export const DEFAULT_BUDGET_USD = 6;
export const DEFAULT_JUDGE_BUDGET_USD = 4;

export type TranslationStatus = "ok" | "refusal" | "truncated" | "empty" | "error";
export type JudgeStatus = "ok" | "refusal" | "truncated" | "invalid" | "error";

export interface OutputRecord {
  item: string;
  arm: ArmId;
  model: string;
  status: TranslationStatus;
  text: string | null;
  stop_reason: string | null;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  /** Why an error, as a short code: never the provider's words, never the text. */
  reason?: string;
  ts: string;
}

export interface JudgeRecord {
  item: string;
  status: JudgeStatus;
  /** For each label shown, from 1, the arms whose identical output it was. */
  labels: Array<{ label: number; arms: ArmId[] }>;
  ratings: Array<Rating & { arms: ArmId[] }>;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  reason?: string;
  ts: string;
}

export interface RunConfig {
  /** Whose ledger: the repository for a real run, a temporary directory for a dry run. */
  root: string;
  runId: string;
  runDir: string;
  items: readonly BlindItem[];
  /** sha256 of the sentence file, so a resumed run cannot silently mix two sets. */
  setSha256: string;
  limit: number | null;
  budgetUsd: number;
  judgeBudgetUsd: number;
  judge: boolean;
  dryRun: boolean;
}

export interface RunDeps {
  clientFor: (model: string, profile: RequestProfile) => LlmClient;
  log: (line: string) => void;
  /** How a row reaches the ledger. Injectable ONLY so a failing append can be tested. */
  appendRecord?: typeof append;
}

export interface RunSummary {
  runDir: string;
  selected: number;
  translationsRecorded: number;
  judged: number;
  /** Why a phase stopped early, if one did. */
  stops: string[];
  /** Arms (or the judge) switched off by a failure retrying cannot fix, and why. */
  disabled: Record<string, string>;
}

/** Refusal to start: missing key, missing or unwritable ledger, a resumed run that does not match. */
export class BlindRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlindRefusal";
  }
}

/** The ledger could not be written: the run stops rather than spend untracked. */
class LedgerWriteFailed extends Error {}

interface Running {
  controller: AbortController;
  worstCaseUsd: number;
  model: string;
  note: string;
  abandoned: boolean;
}

type CallOutcome =
  | { kind: "answer"; text: string; stopReason: string | null; inputTokens: number; outputTokens: number; costUsd: number | null; latencyMs: number }
  | { kind: "error"; terminal: boolean; reason: string; latencyMs: number }
  | { kind: "refused"; reason: string }
  | { kind: "abandoned" };

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The last record per key, so a retried error is superseded by what the retry got. */
function latestBy<T>(records: readonly T[], key: (r: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const record of records) out.set(key(record), record);
  return out;
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export class BlindRun {
  readonly runRoom: string;
  private readonly budget: RunBudget;
  private readonly running = new Set<Running>();
  private readonly disabled: Record<string, string> = {};
  private readonly stops: string[] = [];
  private readonly clients = new Map<string, LlmClient>();
  private readonly seed: number;
  private fatal: Error | null = null;

  constructor(
    private readonly config: RunConfig,
    private readonly deps: RunDeps,
  ) {
    this.runRoom = roomHash(`BLIND-${config.runId}`);
    this.budget = new RunBudget(config.root, this.runRoom, config.budgetUsd, config.judgeBudgetUsd, JUDGE_MODEL);
    this.seed = seedFrom(`blind:${config.runId}`);
  }

  get outputsPath(): string {
    return join(this.config.runDir, "outputs.jsonl");
  }

  get judgePath(): string {
    return join(this.config.runDir, "judge.jsonl");
  }

  get seedValue(): number {
    return this.seed;
  }

  /** The items this run covers, in file order. */
  selected(): BlindItem[] {
    return selectBalanced(this.config.items, this.config.limit);
  }

  async execute(): Promise<RunSummary> {
    this.preflight();
    const selected = this.selected();
    const order = interleaveByTarget(selected);

    for (let pass = 1; pass <= TRANSLATION_PASSES && this.stops.length === 0; pass += 1) {
      const done = latestBy(readJsonl<OutputRecord>(this.outputsPath), (r) => `${r.item}:${r.arm}`);
      const tasks = order.flatMap((item) =>
        ARMS.filter((arm) => {
          const prior = done.get(`${item.id}:${arm.id}`);
          return prior === undefined || prior.status === "error";
        }).map((arm) => ({ item, arm })),
      );
      if (tasks.length === 0) break;
      this.deps.log(`translations, pass ${pass}: ${tasks.length} calls to make`);
      await this.pool(tasks, ({ item, arm }) => this.translate(item, arm));
    }

    if (this.config.judge && this.stops.length === 0 && this.fatal === null) {
      await this.judgeAll(order);
    }

    if (this.fatal !== null) throw this.fatal;
    const outputs = latestBy(readJsonl<OutputRecord>(this.outputsPath), (r) => `${r.item}:${r.arm}`);
    const judged = latestBy(readJsonl<JudgeRecord>(this.judgePath), (r) => r.item);
    return {
      runDir: this.config.runDir,
      selected: selected.length,
      translationsRecorded: [...outputs.values()].filter((r) => r.status !== "error").length,
      judged: [...judged.values()].filter((r) => r.status !== "error").length,
      stops: [...this.stops],
      disabled: { ...this.disabled },
    };
  }

  /**
   * Log every call still in flight as one request lost at its worst case, and abort it. Returns how
   * many. For a signal or a crash: whatever those calls cost would otherwise never reach the ledger.
   */
  abandonInFlight(): number {
    const calls = [...this.running].filter((call) => !call.abandoned);
    for (const call of calls) {
      call.abandoned = true;
      try {
        this.recordLost(call);
      } catch {
        // Already stopping. The caller reports a failed append through the ledger's view check.
      }
      call.controller.abort();
    }
    return calls.length;
  }

  /** Regenerate spend_log.md from the ledger, as every spending script does on its way out. */
  flushView(): boolean {
    return flushView(this.config.root);
  }

  // ------------------------------------------------------------------------------------------

  private preflight(): void {
    try {
      load({ root: this.config.root });
    } catch (error) {
      if (error instanceof LedgerNotFound) {
        throw new BlindRefusal(
          `${error.message}. There is no ledger to record this run's spend into, and a budget read off a ledger that ` +
            "does not exist is not a budget. Create out/translatv/spend_log.jsonl first.",
        );
      }
      throw error;
    }
    const writable = ledgerWritable(this.config.root);
    if (!writable.ok) {
      throw new BlindRefusal(`the spend ledger cannot be written (${writable.reason}), so every call would be untracked spend.`);
    }
    if (!(this.config.budgetUsd > 0) || !(this.config.judgeBudgetUsd >= 0)) {
      throw new BlindRefusal("the budgets must be positive amounts of US dollars.");
    }

    mkdirSync(this.config.runDir, { recursive: true });
    const runFile = join(this.config.runDir, "run.json");
    if (existsSync(runFile)) {
      const prior = JSON.parse(readFileSync(runFile, "utf8")) as { limit: number | null; set_sha256: string; dry_run: boolean };
      if (prior.limit !== this.config.limit || prior.set_sha256 !== this.config.setSha256 || prior.dry_run !== this.config.dryRun) {
        throw new BlindRefusal(
          `run ${this.config.runId} was started with --limit ${String(prior.limit)} on sentence set ${prior.set_sha256.slice(0, 12)}` +
            `${prior.dry_run ? " as a dry run" : ""}. Resume it with the same settings, or start a new run id.`,
        );
      }
    } else {
      writeFileSync(
        runFile,
        `${JSON.stringify(
          {
            run_id: this.config.runId,
            created: new Date().toISOString(),
            dry_run: this.config.dryRun,
            limit: this.config.limit,
            set_sha256: this.config.setSha256,
            seed: this.seed,
            ledger_room: this.runRoom,
            budget_usd: this.config.budgetUsd,
            judge_budget_usd: this.config.judgeBudgetUsd,
            arms: ARMS.map((arm) => ({ id: arm.id, model: arm.model, label: arm.label, profile: { ...arm.profile } })),
            judge: { model: JUDGE_MODEL, effort: JUDGE_PROFILE.effort, max_tokens: JUDGE_PROFILE.maxTokens },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
  }

  /** Run tasks MAX_CONCURRENT at a time, in order, until they run out or the run stops. */
  private async pool<T>(tasks: readonly T[], work: (task: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < tasks.length && this.stops.length === 0 && this.fatal === null) {
        const task = tasks[next]!;
        next += 1;
        await work(task);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT, tasks.length) }, worker));
  }

  private client(model: string, profile: RequestProfile): LlmClient {
    const key = `${model}:${JSON.stringify(profile)}`;
    let client = this.clients.get(key);
    if (client === undefined) {
      client = this.deps.clientFor(model, profile);
      this.clients.set(key, client);
    }
    return client;
  }

  private async translate(item: BlindItem, arm: (typeof ARMS)[number]): Promise<void> {
    if (this.disabled[arm.id] !== undefined) return;
    const source = dialectByCode(item.src);
    const target = dialectByCode(item.tgt);
    if (source === null || target === null) throw new Error(`item ${item.id} names a dialect the catalog does not know`);
    // The production prompt, no glossary: the set is synthetic and has none.
    const system = buildSystemPrompt(source, target, []);
    const user = buildUserMessage(contextFor(this.config.items, item), item.text);
    const outcome = await this.call(arm.model, arm.profile, system, user, false, `blind ${this.config.runId} translate ${arm.id} ${item.id}`);

    if (outcome.kind === "refused" || outcome.kind === "abandoned") return;
    const base = { item: item.id, arm: arm.id, model: arm.model, ts: new Date().toISOString() };
    if (outcome.kind === "error") {
      if (outcome.terminal) {
        this.disable(arm.id, outcome.reason);
        return;
      }
      this.write(this.outputsPath, {
        ...base, status: "error", text: null, stop_reason: null, latency_ms: outcome.latencyMs,
        input_tokens: null, output_tokens: null, cost_usd: null, reason: outcome.reason,
      } satisfies OutputRecord);
      return;
    }
    const status: TranslationStatus =
      outcome.stopReason === "refusal" ? "refusal" : outcome.stopReason === "max_tokens" ? "truncated" : outcome.text.length === 0 ? "empty" : "ok";
    this.write(this.outputsPath, {
      ...base, status, text: outcome.text, stop_reason: outcome.stopReason, latency_ms: outcome.latencyMs,
      input_tokens: outcome.inputTokens, output_tokens: outcome.outputTokens, cost_usd: outcome.costUsd,
    } satisfies OutputRecord);
  }

  private async judgeAll(order: readonly BlindItem[]): Promise<void> {
    const outputs = latestBy(readJsonl<OutputRecord>(this.outputsPath), (r) => `${r.item}:${r.arm}`);
    const judged = latestBy(readJsonl<JudgeRecord>(this.judgePath), (r) => r.item);
    const ready = order.filter((item) => {
      const prior = judged.get(item.id);
      if (prior !== undefined && prior.status !== "error") return false;
      const records = ARMS.map((arm) => outputs.get(`${item.id}:${arm.id}`));
      // Paired only: every arm has an outcome, and at least one is a translation to rate.
      return records.every((r) => r !== undefined && r.status !== "error") && records.some((r) => r?.status === "ok");
    });
    if (ready.length === 0) return;
    this.deps.log(`judge: ${ready.length} items to rate`);
    await this.pool(ready, (item) => this.judgeOne(item, outputs));
  }

  /** The distinct translations of an item, in this run's seeded order, labelled from 1. */
  static candidates(
    itemId: string,
    outputs: Map<string, OutputRecord>,
    seed: number,
    salt: string,
  ): Array<{ label: number; text: string; arms: ArmId[] }> {
    const byText = new Map<string, ArmId[]>();
    for (const arm of ARMS) {
      const record = outputs.get(`${itemId}:${arm.id}`);
      if (record?.status !== "ok" || record.text === null) continue;
      byText.set(record.text, [...(byText.get(record.text) ?? []), arm.id]);
    }
    const distinct = [...byText.entries()].map(([text, arms]) => ({ text, arms }));
    return shuffled(distinct, rng(seedFrom(`${seed}:${salt}:${itemId}`))).map((c, i) => ({ label: i + 1, ...c }));
  }

  private async judgeOne(item: BlindItem, outputs: Map<string, OutputRecord>): Promise<void> {
    if (this.disabled["judge"] !== undefined) return;
    const candidates = BlindRun.candidates(item.id, outputs, this.seed, "judge");
    const user = buildJudgeMessage(item, contextFor(this.config.items, item), candidates);
    const outcome = await this.call(JUDGE_MODEL, JUDGE_PROFILE, JUDGE_SYSTEM, user, true, `blind ${this.config.runId} judge ${item.id}`);
    if (outcome.kind === "refused" || outcome.kind === "abandoned") return;
    const labels = candidates.map((c) => ({ label: c.label, arms: c.arms }));
    const base = { item: item.id, labels, ts: new Date().toISOString() };
    if (outcome.kind === "error") {
      if (outcome.terminal) {
        this.disable("judge", outcome.reason);
        return;
      }
      this.write(this.judgePath, {
        ...base, status: "error", ratings: [], latency_ms: outcome.latencyMs, input_tokens: null, output_tokens: null, cost_usd: null,
        reason: outcome.reason,
      } satisfies JudgeRecord);
      return;
    }
    const spent = { latency_ms: outcome.latencyMs, input_tokens: outcome.inputTokens, output_tokens: outcome.outputTokens, cost_usd: outcome.costUsd };
    if (outcome.stopReason === "refusal" || outcome.stopReason === "max_tokens") {
      const status = outcome.stopReason === "refusal" ? "refusal" : "truncated";
      this.write(this.judgePath, { ...base, status, ratings: [], ...spent } satisfies JudgeRecord);
      return;
    }
    const parsed = parseJudgement(outcome.text, candidates.map((c) => c.label));
    if (!parsed.ok) {
      this.write(this.judgePath, { ...base, status: "invalid", ratings: [], reason: parsed.reason, ...spent } satisfies JudgeRecord);
      return;
    }
    const ratings = parsed.ratings.map((r) => ({ ...r, arms: candidates.find((c) => c.label === r.label)!.arms }));
    this.write(this.judgePath, { ...base, status: "ok", ratings, ...spent } satisfies JudgeRecord);
  }

  /**
   * One paid call, with its spend on the ledger before anything is returned. Reserves its worst case
   * first; a refused reservation stops the phase.
   */
  private async call(model: string, profile: RequestProfile, system: string, user: string, judge: boolean, note: string): Promise<CallOutcome> {
    const worstCaseUsd = requestWorstCaseUsd(model, system, user, profile.maxTokens);
    // One worst case per request the call may send: the adapter retries once (MAX_RETRIES), and a
    // first request lost in flight was still billed. Reserving only one would let a run of lost
    // requests carry spend past the budget; reserving all of them keeps the budget a hard cap.
    const reserved = this.budget.reserve(worstCaseUsd === null ? null : worstCaseUsd * (MAX_RETRIES + 1), judge);
    if (!reserved.ok) {
      this.stop(`${judge ? "judge" : "translations"} stopped: ${reserved.reason}`);
      return { kind: "refused", reason: reserved.reason };
    }
    const running: Running = { controller: new AbortController(), worstCaseUsd: worstCaseUsd!, model, note, abandoned: false };
    this.running.add(running);
    const timer = setTimeout(() => running.controller.abort(new Error("call timed out")), CALL_TIMEOUT_MS);
    timer.unref?.();
    const started = performance.now();
    try {
      const result = await this.client(model, profile).complete({
        system,
        user,
        signal: running.controller.signal,
        sendBefore: Date.now() + SEND_WINDOW_MS,
        // Logged the moment it is reported, before any retry goes out.
        onLost: () => {
          if (!running.abandoned) this.recordLost(running);
        },
      });
      const latencyMs = Math.round(performance.now() - started);
      if (running.abandoned) return { kind: "abandoned" };
      const costUsd = this.recordUsage(running, result.inputTokens, result.outputTokens);
      return {
        kind: "answer",
        text: result.text.trim(),
        stopReason: result.stopReason ?? null,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd,
        latencyMs,
      };
    } catch (error) {
      if (error instanceof LedgerWriteFailed) {
        this.fatal = error;
        return { kind: "abandoned" };
      }
      const latencyMs = Math.round(performance.now() - started);
      if (running.abandoned) return { kind: "abandoned" };
      if (error instanceof LlmFailure) return { kind: "error", terminal: error.kind === "terminal", reason: error.reason, latencyMs };
      return { kind: "error", terminal: false, reason: running.controller.signal.aborted ? "timeout" : "unknown", latencyMs };
    } finally {
      clearTimeout(timer);
      this.running.delete(running);
      // Released only now, after the call's own row is on the ledger, so its money is never in
      // neither place.
      this.budget.release(reserved.reservation);
    }
  }

  private recordUsage(running: Running, inputTokens: number, outputTokens: number): number | null {
    let record;
    try {
      record = entry({
        program: PROGRAMS.blindTest,
        kind: "eval",
        model: running.model,
        room: this.runRoom,
        inputTokens,
        outputTokens,
        capUsd: this.config.budgetUsd,
        note: running.note,
      });
    } catch (error) {
      // The ledger refused the row (its cost contradicted its own arithmetic). The call still cost
      // money, so it is logged at its worst case, and the run stops: a refused row is a bug, and
      // carrying on would log every later call the same way.
      this.recordLost(running);
      const failure = new LedgerWriteFailed(
        `the ledger refused a row (${error instanceof Error ? error.message : "unknown"}). It was logged at its worst ` +
          "case instead, and the run is stopped.",
      );
      this.fatal = failure;
      throw failure;
    }
    this.append(record);
    return record.cost_usd;
  }

  private recordLost(running: Running): void {
    this.append(
      entry({
        program: PROGRAMS.blindTest,
        kind: "eval",
        model: running.model,
        room: this.runRoom,
        worstCaseUsd: running.worstCaseUsd,
        capUsd: this.config.budgetUsd,
        note: `${running.note}, cost unknown, logged at its worst case`,
      }),
    );
  }

  private append(record: ReturnType<typeof entry>): void {
    try {
      (this.deps.appendRecord ?? append)(record, this.config.root);
      this.budget.invalidate();
    } catch (error) {
      const failure = new LedgerWriteFailed(
        `the spend ledger could not be written (${error instanceof Error ? error.message : "unknown"}). ` +
          "The run is stopped rather than spend untracked.",
      );
      this.fatal = failure;
      throw failure;
    }
  }

  private write(path: string, record: OutputRecord | JudgeRecord): void {
    appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
  }

  private stop(reason: string): void {
    if (!this.stops.includes(reason)) {
      this.stops.push(reason);
      this.deps.log(reason);
    }
  }

  private disable(name: string, reason: string): void {
    if (this.disabled[name] === undefined) {
      this.disabled[name] = reason;
      this.deps.log(`${name === "judge" ? "the judge" : `arm ${name}`} is off for this run: ${reason}, which retrying cannot fix`);
    }
  }
}
