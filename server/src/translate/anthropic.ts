// The Anthropic implementation of LlmClient.
//
// Deliberately thin: everything interesting (the spend gate, failure behavior, timing)
// lives in TranslationService, which is provider agnostic and tested against a fake.
// Swapping providers should be a new file this size, not a rewrite.
//
// This file owns what TranslationService cannot see: the SDK's exception types, and each request
// on the wire. So it classifies the provider's errors into LlmFailure, makes the one retry, and
// says which failed requests may have been billed (onLost), and the service stays free of any SDK
// import.
//
// Model choices worth stating, because getting them wrong is silent rather than loud. The request
// is a function of the model (REQUEST_PROFILES), because the models in use disagree about which
// fields they accept, and a field one accepts is a 400 on another:
//
//   claude-haiku-4-5   production's model (DEFAULT_MODEL). Its request is exactly what it always
//                      was, pinned byte for byte by a test.
//     temperature 0.2  ACCEPTED on Haiku 4.5. Consistency matters more than variety for
//                      subtitles: the same sentence should not translate three different ways.
//     no effort        output_config.effort ERRORS on Haiku 4.5. Passing it would 400 every
//                      request. Verified against the API reference, not assumed.
//     no thinking      latency this app cannot afford, and off unless asked for on this model.
//   claude-haiku-5-5   the candidate the blind test (src/eval/blind) measures. Not the default:
//                      switching is the owner's decision after that test.
//     no temperature   a non default temperature, top_p or top_k is a 400 on Haiku 5.5, so none
//                      is sent at all.
//     thinking off     Haiku 5.5 thinks by default (adaptive, effort medium). Off by default here
//                      for the same latency reason, as thinking {type: "disabled"}, which it
//                      accepts at effort low, medium and high. budget_tokens is a 400.
//     refusals         it can stop with stop_reason "refusal" and has no server side fallback.
//                      A refusal comes back as no text (with its usage, so it is logged), which
//                      every caller already treats as a failure, never as a translation.
//   claude-sonnet-5-5  the blind test's judge only, with a profile its caller passes: no
//                      temperature, thinking left at its default (disabled is a 400 there),
//                      effort low, structured output through output_config.format, since forced
//                      tool_choice is a 400 on it too.
//
// Text is read by block type on every model, never as content[0]: a thinking model's answer
// starts with thinking blocks.
//
// The SDK is 0.65.0, whose types predate output_config and adaptive thinking. It is NOT upgraded
// for them: SDK 1.0.0 and later send anthropic-version 2026-10-21, on which a temperature is a
// 400 on every model, so the upgrade would break Haiku 4.5's production request. The two fields
// are typed here (WireParams) and the SDK forwards the body as it is.
//
// Not streaming: output is about 30 tokens and only fires on finalization, so there is nothing
// meaningful to stream.
//
// Prompt caching is deliberately NOT attempted. Haiku 4.5's minimum cacheable prefix is 4096
// tokens and our system prompt plus glossary is about 800, so cache_control would silently do
// nothing: no error, no warning, cache_creation_input_tokens of 0. Padding the prompt past 4096
// tokens to force it would cost more than it saves at these volumes.

import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { subscribe } from "node:diagnostics_channel";
import { DEFAULT_MODEL } from "../spend/pricing.js";
import { LlmFailure, MAX_OUTPUT_TOKENS, type LlmClient } from "./TranslationService.js";

export { MAX_OUTPUT_TOKENS };
export const TEMPERATURE = 0.2;

export type Effort = "low" | "medium" | "high";

/** How one model is asked: which optional fields its request carries. */
export interface RequestProfile {
  /** Sent as temperature, or null to send none, for a model that refuses sampling parameters. */
  readonly temperature: number | null;
  /**
   * omit: no thinking field, the model's own default. disabled: thinking {type: "disabled"}.
   * adaptive: thinking {type: "adaptive"}. Never a budget: budget_tokens is a 400 on the models
   * that think adaptively.
   */
  readonly thinking: "omit" | "disabled" | "adaptive";
  /** Sent as output_config.effort, or null to send none (it is a 400 on Haiku 4.5). */
  readonly effort: Effort | null;
  readonly maxTokens: number;
  /** A JSON schema the answer must follow, sent as output_config.format, or null for free text. */
  readonly jsonSchema: Record<string, unknown> | null;
}

/**
 * The request shape for each model this repo calls by default. A model missing here gets no client
 * at all (createAnthropicClient throws) rather than a guessed request.
 */
export const REQUEST_PROFILES: Readonly<Record<string, RequestProfile>> = Object.freeze({
  "claude-haiku-4-5": Object.freeze({ temperature: TEMPERATURE, thinking: "omit", effort: null, maxTokens: MAX_OUTPUT_TOKENS, jsonSchema: null }),
  "claude-haiku-5-5": Object.freeze({ temperature: null, thinking: "disabled", effort: null, maxTokens: MAX_OUTPUT_TOKENS, jsonSchema: null }),
});

export function profileFor(model: string): RequestProfile | null {
  return REQUEST_PROFILES[model] ?? null;
}

/**
 * The request body, as sent. The SDK's own params type (0.65.0) has no output_config and no
 * adaptive thinking, so this widens it by exactly those two fields and nothing else.
 */
type WireParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "thinking"> & {
  thinking?: Anthropic.ThinkingConfigDisabled | { type: "adaptive" };
  output_config?: { effort?: Effort; format?: { type: "json_schema"; schema: Record<string, unknown> } };
};

/**
 * Build one request. Keys are added in a fixed order and only when the profile asks for them, so
 * Haiku 4.5's body is byte for byte what it was before profiles existed.
 */
export function requestParams(model: string, profile: RequestProfile, system: string, user: string): WireParams {
  const outputConfig: NonNullable<WireParams["output_config"]> = {
    ...(profile.effort !== null ? { effort: profile.effort } : {}),
    ...(profile.jsonSchema !== null ? { format: { type: "json_schema" as const, schema: profile.jsonSchema } } : {}),
  };
  return {
    model,
    max_tokens: profile.maxTokens,
    ...(profile.temperature !== null ? { temperature: profile.temperature } : {}),
    ...(profile.thinking === "disabled" ? { thinking: { type: "disabled" as const } } : {}),
    ...(profile.thinking === "adaptive" ? { thinking: { type: "adaptive" as const } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    system,
    messages: [{ role: "user", content: user }],
  };
}

/**
 * Retries after the first request, made here rather than by the SDK.
 *
 * The SDK's default is 2, which is right for a batch job and wrong for a live subtitle: three
 * attempts with backoff can consume the whole 6 second timeout before our own handler ever runs,
 * and the user gets a blank line instead of a fast, honest fallback to the original text. One
 * retry absorbs a single blip; beyond that, showing the original beats a late translation.
 *
 * The SDK used to make that retry, and nothing held it to the caller's deadline: its wait cannot
 * be interrupted, so a retry went out after the caller had been told TIMED_OUT, a second paid
 * request whose answer nobody would read (measured in review: a 429 asking for ten seconds put it
 * four seconds past the timeout). Here a retry is sent only if it can start before the deadline,
 * and the SDK is told to make none of its own.
 */
export const MAX_RETRIES = 1;

/**
 * Whether a failed request ever left this machine, as undici, which runs Node's fetch, saw it.
 *
 * That one fact decides whether a failed request may have been billed, and error codes cannot
 * give it. They were tried, and each round of review found failures they missed: refused
 * connections and hosts that did not resolve, then certificates the client rejected. A reset
 * during the TLS handshake carries the same ECONNRESET as a reset after the request went out
 * (both measured). Each miss logged a worst case for a request never sent, and an outage filled a
 * room's cap in 182 lines with nothing spent, which shut the room's translation off for the day.
 *
 * undici says it directly, on a documented diagnostics channel
 * (https://undici.nodejs.org/#/docs/api/DiagnosticsChannel). "undici:client:connectError" fires
 * with the error a connection failed with: refused, a lookup, the TLS handshake, the connect
 * timeout, or setting up either protocol on the socket. undici then fails the requests waiting on
 * that connection with the same object, which fetch gives as its TypeError's cause (measured on
 * Node 22), and only while none is in flight, so none of them was written (read in the undici that
 * Node 22.22.2 bundles). That is positive evidence. The first version of this inferred "never
 * written" from the absence of "undici:client:sendHeaders", which only HTTP/1 publishes, so over
 * HTTP/2 a request sent and then lost would have read as never sent: the harmful direction (found
 * in review). Should undici stop publishing connectError, every failure counts as sent, the safe
 * direction, and the loopback tests in anthropic.test.ts go red.
 */
const connectErrors = new WeakSet<object>();

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

subscribe("undici:client:connectError", (message) => {
  const { error } = message as { error?: unknown };
  if (isObject(error)) connectErrors.add(error);
});

/**
 * Whether undici failed this fetch before writing any of its request: an error a connection failed
 * with is somewhere in its causes. Usually it is fetch's own cause, but fetch can wrap it once
 * more: a proxy that refuses the tunnel fails the connection with an AbortError, which fetch
 * reports as a cancelled request whose cause it is (measured). Read one level deep, that was
 * counted as sent, at round 1's lockout rate (found in review). Walking further is safe because
 * a connect error only ever fails requests none of which was written, and the depth is bounded so
 * a cause that loops ends the walk. An error undici never reported as a connection's, such as
 * fetch refusing a URL before undici saw it, counts as written: nobody can say it was not sent.
 */
function neverWritten(error: unknown): boolean {
  let link: unknown = error;
  for (let depth = 0; depth < 4 && isObject(link); depth += 1) {
    if (connectErrors.has(link)) return true;
    link = (link as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A request undici failed before writing any of it: nothing was sent, so nothing was billed.
 *
 * It replaces the error fetch gave, which the SDK cannot be handed as it is. The SDK reads a
 * failure as its own timeout when its text or its cause's says it timed out, and a connect
 * timeout's does: that is what a network that swallows packets gives. The SDK's timeout error
 * does not say where the request failed, so it would be counted lost with nothing sent.
 */
class NeverSent extends TypeError {
  constructor() {
    super("fetch failed before any of the request was written");
    this.name = "NeverSent";
  }
}

/**
 * Whether a failed request may have been billed: it was sent, and no answer came back. A request
 * undici failed before writing any of it (NeverSent) and one the provider answered with a status
 * were not.
 */
function maybeBilled(error: unknown): boolean {
  if (error instanceof APIConnectionError && error.cause instanceof NeverSent) return false;
  // Anthropic does not bill a request it answered with an error.
  if (error instanceof APIError && typeof error.status === "number") return false;
  // Everything else was or may have been sent: a connection that failed after the request was
  // written, the SDK's own timeout (it carries no cause, so where it gave up is unknown), an
  // answer that could not be read, or anything nobody classified.
  return true;
}

/**
 * How long to wait before the retry, or null when this failure does not get one. The rules are
 * the SDK's own, read from its source (0.65.0), so that moving the retry here changed only when it
 * may go out. A retry is due when the server says so (x-should-retry), else for any connection
 * failure, a request timeout, a lock timeout, a rate limit or a server error. The wait is what
 * retry-after-ms asks, else retry-after in seconds or as a date, when that is more than zero and
 * under a minute; otherwise half a second, less up to a quarter for jitter.
 */
function retryDelayMs(error: unknown): number | null {
  const backoff = 500 * (1 - Math.random() * 0.25);
  if (error instanceof APIConnectionError) return backoff;
  if (!(error instanceof APIError) || typeof error.status !== "number") return null;
  const said = error.headers?.get("x-should-retry");
  const status = error.status;
  const retryable = said === "true" || (said !== "false" && (status === 408 || status === 409 || status === 429 || status >= 500));
  if (!retryable) return null;
  const asked = retryAfterMs(error.headers);
  return asked !== undefined && asked > 0 && asked < 60_000 ? asked : backoff;
}

/**
 * The wait the provider asked for, read as the SDK reads it. A retry-after-ms of zero is no answer,
 * so retry-after is read next, as the SDK does.
 */
function retryAfterMs(headers: Headers | undefined): number | undefined {
  let wait: number | undefined;
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (!Number.isNaN(ms)) wait = ms;
  const after = headers?.get("retry-after");
  if (after && !wait) {
    const seconds = Number.parseFloat(after);
    wait = Number.isNaN(seconds) ? Date.parse(after) - Date.now() : seconds * 1000;
  }
  return wait;
}

/** Wait, unless the call is aborted first. Nothing is in flight meanwhile, so an abort loses nothing. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * Classify an SDK error into something TranslationService can act on.
 *
 * Ordered most specific first, per the SDK's own guidance. The split that matters is terminal
 * versus retriable: a 401 is a configuration fact and no number of retries changes it, while a
 * 429 is a moment in time and the next attempt genuinely might succeed.
 */
function classify(error: unknown, model: string): LlmFailure {
  if (error instanceof AuthenticationError) {
    return new LlmFailure(
      "terminal",
      "auth",
      "the Anthropic API key was rejected. Check ANTHROPIC_API_KEY, then restart the server.",
    );
  }
  if (error instanceof PermissionDeniedError) {
    return new LlmFailure(
      "terminal",
      "permission",
      "the Anthropic API key lacks permission for this model.",
    );
  }
  if (error instanceof NotFoundError) {
    // Almost always a wrong or retired model id. Retrying a 404 forever is pure waste.
    return new LlmFailure(
      "terminal",
      "not_found",
      `the model ${model} was not found. It may have been renamed or retired.`,
    );
  }
  if (error instanceof BadRequestError) {
    // A malformed request is our bug, not a blip. Retrying reproduces it exactly.
    return new LlmFailure(
      "terminal",
      "bad_request",
      "the translation request was rejected as malformed.",
    );
  }
  if (error instanceof RateLimitError) {
    return new LlmFailure("retriable", "rate_limit", "translating too fast, catching up");
  }
  // Checked BEFORE the generic APIError: in this SDK APIConnectionError extends APIError, so
  // the broad check would swallow it and report a misleading status.
  if (error instanceof APIConnectionError) {
    return new LlmFailure("retriable", "connection", "could not reach the translation service");
  }
  if (error instanceof APIError) {
    // 5xx and anything else the SDK surfaced with a status. Server side and usually transient.
    return new LlmFailure("retriable", `status_${error.status ?? "unknown"}`, "translation failed");
  }
  return new LlmFailure("retriable", "unknown", "translation failed");
}

/**
 * @param options.fetch Stands in for the network, so the adapter's handling of each request can be
 *   tested against the real SDK with no key and no spend (anthropic.test.ts).
 * @param options.baseURL Where requests go, so the tests can point the real fetch at a loopback
 *   server that fails the way a network does. Unset in production: the SDK's default.
 */
export function createAnthropicClient(
  apiKey: string,
  options: {
    fetch?: typeof fetch;
    baseURL?: string;
    /** The model every request names. DEFAULT_MODEL unless a caller (the blind test) asks for another. */
    model?: string;
    /** How that model is asked. Its REQUEST_PROFILES entry unless given. */
    profile?: RequestProfile;
  } = {},
): LlmClient {
  const model = options.model ?? DEFAULT_MODEL;
  const profile = options.profile ?? profileFor(model);
  if (profile === null) {
    throw new Error(`no request profile for ${model}: add one to REQUEST_PROFILES, or pass one, rather than guess its request`);
  }
  const send = options.fetch ?? globalThis.fetch;
  const anthropic = new Anthropic({
    apiKey,
    baseURL: options.baseURL,
    maxRetries: 0,
    fetch: (url, init) =>
      send(url, init).catch((error: unknown) => {
        throw neverWritten(error) ? new NeverSent() : error;
      }),
  });

  return {
    async complete({ system, user, signal, sendBefore, onLost }) {
      let response;
      for (let attempt = 0; ; attempt += 1) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        try {
          // The one widening cast: WireParams is the SDK's type plus output_config and adaptive
          // thinking, which this SDK forwards in the body untouched (see the header).
          response = await anthropic.messages.create(
            requestParams(model, profile, system, user) as Anthropic.MessageCreateParamsNonStreaming,
            { signal },
          );
          break;
        } catch (error) {
          // Aborted in flight: its answer will never be read. The SDK's abort error does not say
          // whether any of the request was written, so it is counted lost. At the ceiling it was
          // (a connection is given up on after 10 s, long before); at shutdown it may not have
          // been, which over-counts, the safe direction. The abort is the caller's own, not a
          // provider fault, so it is rethrown untouched: wrapped, a timeout would look like an API
          // failure.
          if (signal.aborted) {
            onLost();
            throw error;
          }
          // Reported, and so logged, before any retry goes out: every row is appended before the
          // next call is issued (CLAUDE.md).
          if (maybeBilled(error)) onLost();
          const failure = classify(error, model);
          // Not only a retriable failure: the SDK retried whatever the server said to
          // (x-should-retry), even a 400.
          const delay = attempt < MAX_RETRIES ? retryDelayMs(error) : null;
          if (delay === null || Date.now() + delay >= sendBefore) throw failure;
          await pause(delay, signal);
          // Checked again once the wait is over, because a busy event loop can end it late: a
          // 700 ms stall during a 300 ms wait sent the retry 301 ms past the deadline (measured in
          // review). From here to fetch is one turn of the event loop (measured), so no stall can
          // land between.
          if (Date.now() >= sendBefore) throw failure;
        }
      }

      // A refusal is billed like any answer, so its usage is returned for the ledger, but its text,
      // partial or not, is never an answer: no text is what every caller already treats as failed.
      const refused = response.stop_reason === "refusal";
      const text = refused
        ? ""
        : response.content
            .filter((block): block is Anthropic.TextBlock => block.type === "text")
            .map((block) => block.text)
            .join("")
            .trim();

      return {
        text,
        stopReason: response.stop_reason,
        // The API's own usage numbers, which is what makes the ledger's cost_source "logged"
        // rather than an estimate. Never substitute a token count of our own here.
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
