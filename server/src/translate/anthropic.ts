// The Anthropic implementation of LlmClient.
//
// Deliberately thin: everything interesting (ordering, the spend gate, failure
// behavior) lives in TranslationService, which is provider agnostic and tested against a fake.
// Swapping providers should be a new file this size, not a rewrite.
//
// This file owns what TranslationService cannot see: the SDK's exception types, and each request
// on the wire. So it classifies the provider's errors into LlmFailure, makes the one retry, and
// says which failed requests may have been billed (onLost), and the service stays free of any SDK
// import.
//
// Model choices worth stating, because getting them wrong is silent rather than loud:
//   claude-haiku-4-5   the current alias. Aliases are the recommended form over dated ids.
//   temperature 0.2    ACCEPTED on Haiku 4.5. Sampling parameters were removed on Opus 4.7 and
//                      later, and on Sonnet 5 and Fable 5, but not here. Consistency matters
//                      more than variety for subtitles: the same sentence should not translate
//                      three different ways.
//   no effort          output_config.effort ERRORS on Haiku 4.5. Passing it would 400 every
//                      request. Verified against the API reference, not assumed.
//   no thinking        latency this app cannot afford.
//   not streaming      output is about 30 tokens and only fires on finalization, so there is
//                      nothing meaningful to stream.
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
function classify(error: unknown): LlmFailure {
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
      `the model ${DEFAULT_MODEL} was not found. It may have been renamed or retired.`,
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
export function createAnthropicClient(apiKey: string, options: { fetch?: typeof fetch; baseURL?: string } = {}): LlmClient {
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
          response = await anthropic.messages.create(
            {
              model: DEFAULT_MODEL,
              max_tokens: MAX_OUTPUT_TOKENS,
              temperature: TEMPERATURE,
              system,
              messages: [{ role: "user", content: user }],
            },
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
          const failure = classify(error);
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

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("")
        .trim();

      return {
        text,
        // The API's own usage numbers, which is what makes the ledger's cost_source "logged"
        // rather than an estimate. Never substitute a token count of our own here.
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    },
  };
}
