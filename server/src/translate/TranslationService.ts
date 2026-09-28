// The translation pipeline: ordering, the spend gate, and failure behavior.
//
// The client is injected rather than constructed here, so every test runs against a fake and no
// test ever touches the network or spends money. That is also what makes the "no API key"
// degraded mode a first class path instead of an error case: a null client is a valid client.
//
// The rule that governs everything below: THE SCREEN MUST NEVER LOOK BROKEN. A failure shows
// the original text where the translation would go, marked, and the line stays in the
// transcript. Never a blank line, never an endless spinner, never a raw error string.

import {
  dialectByCode,
  type GlossaryEntry,
  type TranslationFailureCode,
} from "@translatv/shared";
import { append, entry as ledgerEntry, type SpendKind } from "../spend/ledger.js";
import { PROGRAMS, type SpendGate } from "../spend/caps.js";
import { costUsd, DEFAULT_MODEL } from "../spend/pricing.js";
import { log } from "../log.js";
import { buildSystemPrompt, buildUserMessage, type ContextTurn } from "./prompt.js";

/**
 * The spend gate's refusal reasons, as wire codes.
 *
 * A map rather than a switch, so adding a reason to the gate without deciding what the reader is
 * told fails to compile instead of arriving on screen as nothing at all.
 */
const CAP_REASONS: Record<
  "daily_cap" | "room_cap" | "ledger_unreadable",
  TranslationFailureCode
> = {
  daily_cap: "DAILY_CAP",
  room_cap: "ROOM_CAP",
  ledger_unreadable: "LEDGER_UNREADABLE",
};

/** How long to wait on the API before giving up on a line. */
export const TIMEOUT_MS = 6_000;
/**
 * How long after it was sent a call is given before it is abandoned. Past TIMEOUT_MS the caller
 * has already been answered and the call runs on only to learn what it cost (settleLate); a
 * translation of about 30 tokens that has not come back in a minute is not coming.
 */
export const LATE_CEILING_MS = 60_000;
/**
 * The most output one call may produce. Lives here, not in the adapter, because the worst case a
 * lost call is logged at is computed here and must use the same number the request is sent with.
 */
export const MAX_OUTPUT_TOKENS = 512;
/** Tokens the message framing adds around the prompt, generously. Only feeds the worst case. */
const FRAMING_TOKENS = 64;
/** Concurrent in flight calls across the whole process. */
export const MAX_CONCURRENT = 8;

/**
 * Consecutive failed ledger writes before translation stops.
 *
 * Not 1: a lone failure can be transient, and latching the server off over one blip is its own
 * outage. Not 50 either: every attempt past the first is a paid call whose cost nothing recorded.
 * Three is enough to distinguish a broken permission from a hiccup while keeping the untracked
 * spend to something countable.
 */
export const LEDGER_FAILURE_LIMIT = 3;

export interface TranslateRequest {
  lineId: string;
  text: string;
  sourceDialect: string;
  targetDialect: string;
  context: readonly ContextTurn[];
  glossary: readonly GlossaryEntry[];
  roomHash: string;
  kind: SpendKind;
}

export interface TranslateOk {
  ok: true;
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface TranslateErr {
  ok: false;
  status: "unavailable" | "rate_limited" | "budget_exceeded";
  /**
   * WHY, as a wire code the reader's own copy is looked up by.
   *
   * This was an English sentence, and it went straight onto the screen of whoever was in the
   * call, whatever language they had picked. The sentence now lives in the client's copy files,
   * one per language, and only the code crosses the wire.
   */
  reason: TranslationFailureCode;
  retriable: boolean;
}

export type TranslateResult = TranslateOk | TranslateErr;

/**
 * The minimal shape this service needs from an LLM client.
 *
 * Deliberately not the Anthropic SDK's type: depending on the SDK's surface here would make
 * every test need a mock of it, and would make swapping the provider a rewrite of this file
 * rather than a new adapter.
 */
export interface LlmClient {
  complete(input: {
    system: string;
    user: string;
    signal: AbortSignal;
    /**
     * No request may be sent at or after this time (milliseconds since the epoch). By then the
     * caller has been told TIMED_OUT, so a request sent later is paid for and read by nobody.
     */
    sendBefore: number;
    /**
     * Called once for each request that was sent and may have been billed, but whose answer never
     * came: a connection lost mid request, or an abort while it was in flight. The caller logs
     * each as unknown, at one request's worst case, the moment it is called. A request that never
     * left, or that the provider answered with an error, was not billed and is not reported: only
     * the client can tell those apart, which is why it reports rather than the caller guessing
     * from the error.
     */
    onLost: () => void;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/** A call on its way to the provider, from the moment it is sent until it settles. */
interface RunningCall {
  request: TranslateRequest;
  controller: AbortController;
  /** One request's worst case, or null when the model has no documented price. */
  worstCaseUsd: number | null;
  /** Already logged and aborted at shutdown, so nothing it reports later is logged again. */
  abandoned: boolean;
}

/**
 * A classified failure from an LLM client.
 *
 * The adapter owns the classification, because only it knows the provider's error types, and
 * this service stays provider agnostic by depending on this shape rather than on the SDK's.
 *
 * The distinction is not cosmetic. Before this existed, every failure came back retriable, so a
 * bad API key rendered as "retry translation" on every line: the user could click forever and
 * nothing anywhere said the key was wrong. Retrying a 401 does not fix a 401.
 */
export class LlmFailure extends Error {
  constructor(
    /**
     * terminal means retrying cannot help: a bad key, a revoked key, a wrong model id.
     * retriable means the next attempt genuinely might succeed: a rate limit, a 500, a socket.
     */
    readonly kind: "terminal" | "retriable",
    /** Short machine readable cause, for logs. Never contains the key or user text. */
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "LlmFailure";
  }
}

export class TranslationService {
  private inFlight = 0;
  /** Every call still running, in time or late (settleLate), until it settles. */
  private readonly running = new Set<RunningCall>();
  private readonly queues = new Map<string, Promise<unknown>>();
  /**
   * Set once a terminal failure proves the configuration is wrong.
   *
   * A bad key does not get better by being used again, and hammering a rejecting endpoint once
   * per spoken sentence is both useless and rude. Latching here converts an infinite stream of
   * identical failures into one loud log line and a stable, honest UI state.
   */
  private disabledReason: string | null = null;

  /**
   * The same latch, as the code the reader is told.
   *
   * Kept beside the operator's sentence rather than derived from it, because the two causes that
   * set the latch (a provider that rejected us, a ledger that cannot be written) are different
   * facts and a reader given the wrong one is misled about what is broken. Reading the cause out
   * of the English sentence would be exactly the kind of guess this repo refuses elsewhere.
   */
  private disabledCode: TranslationFailureCode | null = null;

  /**
   * Consecutive failed ledger writes.
   *
   * Counted rather than latched on the first, because a single failure can be transient (a disk
   * that filled and was cleared) and latching the server off for its whole life over one blip
   * would be its own outage. A RUN of them means something is actually broken.
   */
  private ledgerFailures = 0;

  constructor(
    private readonly client: LlmClient | null,
    private readonly gate: SpendGate,
    private readonly repoRoot: string,
    /**
     * How a record reaches the ledger. Injectable ONLY so the untracked spend path can be
     * tested: reproducing it for real needs a file the process cannot write, and a test that
     * chmods one does not run as root, which is exactly where nobody would notice it skipping.
     */
    private readonly appendRecord: typeof append = append,
  ) {}

  get enabled(): boolean {
    return this.client !== null && this.disabledReason === null;
  }

  /** Why translation turned itself off, or null. Surfaced on /healthz for operators. */
  get disabled(): string | null {
    return this.disabledReason;
  }

  /** How many rooms still hold a queue entry. Exposed so the leak is observable in a test. */
  get pendingRooms(): number {
    return this.queues.size;
  }

  /**
   * Drop a room's queue entry.
   *
   * The chain is per room and the rooms themselves are swept, but nothing released this map, so
   * it grew for the lifetime of the process: one entry per room ever translated in, held forever.
   * Called from the same sweep that destroys a room and from the end path, so all three lifetimes
   * (room, session, queue) finish together rather than two of the three.
   */
  forgetRoom(roomHash: string): void {
    this.queues.delete(roomHash);
  }

  /**
   * Translate one line, preserving per room ordering.
   *
   * Ordering matters: two finals from the same speaker translated concurrently can complete out
   * of order, and a transcript that reorders itself reads as a bug even when every line is
   * correct. Chaining per room costs a little latency and buys correct order.
   */
  async translate(request: TranslateRequest): Promise<TranslateResult> {
    const previous = this.queues.get(request.roomHash) ?? Promise.resolve();
    const run = previous.then(() => this.execute(request));
    // Swallow rejections on the chain itself so one failure does not poison the queue for
    // every later line in the same room.
    this.queues.set(
      request.roomHash,
      run.catch(() => undefined),
    );
    return run;
  }

  private async execute(request: TranslateRequest): Promise<TranslateResult> {
    if (this.client === null) {
      return {
        ok: false,
        status: "unavailable",
        reason: "NOT_CONFIGURED",
        retriable: false,
      };
    }

    if (this.disabledReason !== null) {
      return {
        ok: false,
        status: "unavailable",
        // The provider's own words stay in the log and out of the call. They are English
        // operator diagnostics, and they can quote configuration back at whoever is reading.
        reason: this.disabledCode ?? "PROVIDER_REJECTED",
        // NOT retriable. Offering a retry button for a broken key invites the user to click it
        // forever against a server that already knows the answer.
        retriable: false,
      };
    }

    if (this.inFlight >= MAX_CONCURRENT) {
      return {
        ok: false,
        status: "rate_limited",
        reason: "TOO_MANY_IN_FLIGHT",
        retriable: true,
      };
    }

    // The spend gate reads the LEDGER, not a counter, so a restart cannot reset the day.
    const decision = this.gate.check(request.roomHash);
    if (!decision.allowed) {
      log.warn("translation.blocked", { reason: decision.reason, room: request.roomHash });
      return {
        ok: false,
        status: decision.reason === "room_cap" || decision.reason === "daily_cap"
          ? "budget_exceeded"
          : "unavailable",
        // The gate's own message carries dollar figures and is written for an operator reading
        // logs, which is where it stays. The reader gets told the cap was reached, not the
        // server's finances.
        reason: CAP_REASONS[decision.reason],
        retriable: false,
      };
    }

    const source = dialectByCode(request.sourceDialect);
    const target = dialectByCode(request.targetDialect);

    // A dialect the catalog does not know. REFUSED, not resolved to a default.
    //
    // This used to fall back to en-US on both sides before comparing, which had two consequences
    // and both were silent. An unknown dialect facing an English speaker matched the same
    // language backstop below and was ECHOED: the original text came back ok and the client
    // rendered it as a finished translation. An unknown dialect facing a Spanish speaker built a
    // prompt that said "translate to American English" for a reader who never asked for English.
    //
    // The WS handler refuses before it ever gets here, so this is the second lock on one door,
    // and it is the lock that protects any future caller of translate().
    if (source === null || target === null) {
      return {
        ok: false,
        status: "unavailable",
        reason: "UNRESOLVED_DIALECT",
        // The same two codes will not resolve any better next time.
        retriable: false,
      };
    }

    // Same language both ways is a no op. Spending a call to translate English to English would
    // be pure waste, and the echo origin tells the client to render it without a marker.
    //
    // This is now the BACKSTOP, not the primary. The WS handler decides via translationNeed
    // before a line is even created, so a same language line never reaches here: it takes no rate
    // limit token, announces no pending translation, and is never asked whether the budget allows
    // it. This stays because it is cheap and because any future caller of translate() gets the
    // protection for free. A property test asserts the two rules cannot drift apart.
    if (source.language === target.language) {
      return { ok: true, text: request.text, inputTokens: 0, outputTokens: 0 };
    }

    const system = buildSystemPrompt(source, target, request.glossary);
    const user = buildUserMessage(request.context, request.text);
    const running: RunningCall = {
      request,
      controller: new AbortController(),
      worstCaseUsd: this.worstCaseUsd(system, user),
      abandoned: false,
    };
    const client = this.client;
    this.inFlight += 1;
    this.running.add(running);
    // Wrapped, so a client that throws rather than rejecting still releases its slot.
    const call = (async () =>
      client.complete({
        system,
        user,
        signal: running.controller.signal,
        sendBefore: Date.now() + TIMEOUT_MS,
        // Logged the moment it is reported, like every row: never batched to the end of a call.
        onLost: () => {
          if (!running.abandoned) this.record(request, { worstCaseUsd: running.worstCaseUsd }, "no answer");
        },
      }))();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      call.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), TIMEOUT_MS);
      }),
    ]);
    clearTimeout(timer);

    if (outcome === "timeout") {
      // Worth another try: the next sentence may land in a quieter moment. The call itself is
      // NOT aborted here, because a request the client abandons is still billed (see settleLate).
      log.warn("translation.timeout", { room: request.roomHash, lineId: request.lineId });
      this.settleLate(running, call);
      return {
        ok: false,
        status: "unavailable",
        reason: "TIMED_OUT",
        retriable: true,
      };
    }
    this.inFlight -= 1;
    this.running.delete(running);

    if ("error" in outcome) {
      const error = outcome.error;
      if (error instanceof LlmFailure && error.kind === "terminal") {
        // Configuration is wrong and will stay wrong. Latch off, and say so loudly enough that
        // an operator reading logs sees the cause rather than a wall of identical failures.
        this.disabledReason = error.message;
        this.disabledCode = "PROVIDER_REJECTED";
        log.error("translation.disabled", {
          reason: error.reason,
          message: error.message,
          detail:
            "translation is now OFF for this process. The call, the transcript, and the " +
            "original language subtitles all keep working. Fix the configuration and restart.",
        });
        return {
          ok: false,
          status: "unavailable",
          reason: "PROVIDER_REJECTED",
          retriable: false,
        };
      }

      // Nothing to log here: the client has already reported each request that was sent and
      // lost (onLost), and one that never left or that the provider refused was not billed.
      const reason = error instanceof LlmFailure ? error.reason : "unknown";
      log.warn("translation.failed", {
        room: request.roomHash,
        lineId: request.lineId,
        reason,
      });
      return {
        ok: false,
        status: reason === "rate_limit" ? "rate_limited" : "unavailable",
        reason: reason === "rate_limit" ? "PROVIDER_RATE_LIMITED" : "PROVIDER_ERROR",
        retriable: true,
      };
    }

    const result = outcome.result;
    const text = result.text.trim();
    // Log the spend BEFORE returning, so a crash between here and the caller cannot lose the
    // record of money already spent. Batching this to the end of a session is how spend goes
    // untracked, which is the failure this whole project is built not to repeat. An empty answer
    // was billed and reached nobody, so no user is charged for it.
    this.record(request, result, text.length === 0 ? "empty answer" : undefined);

    if (text.length === 0) {
      return {
        ok: false,
        status: "unavailable",
        reason: "EMPTY_RESULT",
        retriable: true,
      };
    }
    return { ok: true, text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }

  /**
   * A call the caller stopped waiting for.
   *
   * It is NOT aborted at the timeout. A request the client abandons is still billed (Anthropic's
   * billing terms), so the abort this used to be only hid the spend: no ledger row for money that
   * went out. The call runs on, sending no new request (sendBefore), and what it cost is logged
   * as it settles: its real cost if it answers, or, for a request that was sent and lost its
   * answer, one request's worst case, counted by the caps. A call that has not answered by
   * LATE_CEILING_MS is aborted after all, and the client reports its request lost. Its slot stays
   * taken until then, which bounds a hung provider to MAX_CONCURRENT calls of unknown cost at a
   * time. The late translation is dropped (the line already showed its original), and none of
   * this is charged to a user: the house pays for what never reached anyone (owner decision,
   * 2026-09-28).
   */
  private settleLate(running: RunningCall, call: Promise<{ text: string; inputTokens: number; outputTokens: number }>): void {
    const ceiling = setTimeout(() => running.controller.abort(), LATE_CEILING_MS - TIMEOUT_MS);
    ceiling.unref?.();
    void call
      .then(
        (result) => {
          if (!running.abandoned) this.record(running.request, result, "answered late");
        },
        // Nothing to log: the client reported each lost request itself, the one the ceiling's
        // abort cut off included.
        () => undefined,
      )
      .finally(() => {
        clearTimeout(ceiling);
        this.running.delete(running);
        this.inFlight -= 1;
      });
  }

  /**
   * Log every call still running, late or in time, as one request lost at its worst case, and
   * abort it. Returns how many.
   *
   * For shutdown: the process is about to exit, and whatever those calls end up costing would
   * otherwise never reach the ledger. A call caught between two requests has none in flight and
   * is counted anyway, because the harmful direction is under-counting.
   */
  abandonInFlight(): number {
    const calls = [...this.running].filter((call) => !call.abandoned);
    for (const call of calls) {
      call.abandoned = true;
      this.record(call.request, { worstCaseUsd: call.worstCaseUsd }, "no answer");
      call.controller.abort();
    }
    return calls.length;
  }

  /**
   * The most one request can be billed, or null when the model has no documented price (unknown,
   * never a zero standing in for it).
   *
   * Input: the prompt's UTF-8 bytes, since a byte level tokenizer never makes more tokens than
   * bytes, plus an allowance for the message framing. Output: MAX_OUTPUT_TOKENS, all of it. Each
   * request is logged on its own row, so a retry is its own worst case. Far above a real call
   * (about $0.0006 against a worst case near $0.004), which is the point: it stands in for a cost
   * nobody could recover, and the harmful direction is under-counting.
   */
  private worstCaseUsd(system: string, user: string): number | null {
    const inputTokens = Buffer.byteLength(system, "utf8") + Buffer.byteLength(user, "utf8") + FRAMING_TOKENS;
    return costUsd(DEFAULT_MODEL, inputTokens, MAX_OUTPUT_TOKENS);
  }

  /**
   * Append one request's spend. `spent` is its usage, or, when nobody can know what it was billed,
   * its worst case. `unbilled` names why no user may be charged for it (it reached nobody); an
   * answer delivered in time leaves it out and is billable like every ordinary row.
   */
  private record(
    request: TranslateRequest,
    spent: { inputTokens: number; outputTokens: number } | { worstCaseUsd: number | null },
    unbilled?: "answered late" | "no answer" | "empty answer",
  ): void {
    try {
      const program =
        request.kind === "eval"
          ? PROGRAMS.autopilotEval
          : request.kind === "term-extraction"
            ? PROGRAMS.runtimeTermExtraction
            : request.kind === "verification"
              ? PROGRAMS.verification
              : PROGRAMS.runtimeTranslation;

      this.appendRecord(
        ledgerEntry({
          program,
          kind: request.kind,
          model: DEFAULT_MODEL,
          room: request.roomHash,
          ...("worstCaseUsd" in spent
            ? { worstCaseUsd: spent.worstCaseUsd }
            : { inputTokens: spent.inputTokens, outputTokens: spent.outputTokens }),
          capUsd: this.gate.capFor(program),
          // "not charged to a user": the provider may well have billed it, and the house pays.
          note: unbilled === undefined ? request.kind : `${request.kind}, ${unbilled}, not charged to a user`,
          billable: unbilled === undefined,
        }),
        this.repoRoot,
      );
      // Our own append changes the file, and filesystem mtime resolution is coarser than the
      // call rate, so relying on the stat alone could reuse a stale parse and overshoot a cap.
      this.gate.invalidate();
      this.ledgerFailures = 0;
    } catch (error) {
      // A ledger write failing means spend is happening untracked, which is the one failure this
      // project exists to prevent. The call in flight still finishes: dropping a user's sentence
      // to protect a log line is the wrong trade in the moment.
      //
      // What must NOT happen is continuing indefinitely. This used to say "the next cap check
      // will refuse anyway", and that was simply wrong: SpendGate.check refuses on
      // LedgerNotFound, and a ledger that cannot be WRITTEN still exists and still parses, so
      // the gate went on reading a stale file and allowing calls. Untracked spend, forever,
      // behind one warning line each. So the failures are counted, and a run of them stops it.
      this.ledgerFailures += 1;
      log.error("ledger.write_failed", {
        error: error instanceof Error ? error.message : "unknown",
        room: request.roomHash,
        consecutive: this.ledgerFailures,
      });

      if (this.ledgerFailures >= LEDGER_FAILURE_LIMIT) {
        this.disabledReason =
          "the spend ledger cannot be written, so translation is stopped rather than " +
          "spending untracked. Check the ledger file's permissions and restart.";
        this.disabledCode = "LEDGER_UNWRITABLE";
        log.error("translation.disabled", {
          reason: "ledger_unwritable",
          consecutive: this.ledgerFailures,
        });
      }
    }
  }
}
