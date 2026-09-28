// The Anthropic implementation of LlmClient.
//
// Deliberately thin: everything interesting (ordering, the spend gate, failure
// behavior) lives in TranslationService, which is provider agnostic and tested against a fake.
// Swapping providers should be a new file this size, not a rewrite.
//
// This file owns ONE thing TranslationService cannot: classifying the provider's errors. Only
// the adapter knows the SDK's exception types, so it translates them into LlmFailure and the
// service stays free of any SDK import.
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
  APIConnectionTimeoutError,
  APIError,
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
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
 * Codes that mean a request never left this machine: the host did not resolve, it refused or
 * could not route the connection, or the connection was never made in time. Nothing was sent, so
 * nothing was billed. Reported as lost, each was logged at its worst case and counted by the caps,
 * so an outage filled a room's cap in 182 lines with nothing spent (measured in review).
 * ECONNREFUSED and ENOTFOUND were measured through this SDK, and UND_ERR_CONNECT_TIMEOUT through
 * Node's fetch (a TLS handshake that never finished, 10.5 s); the others are the same connect
 * phase failures in Node's documentation. Every other connection failure may have come after the
 * request went out.
 */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** The code on an error, and on every cause and aggregated error beneath it. */
function codesOf(error: unknown, depth = 0): string[] {
  if (depth > 8 || typeof error !== "object" || error === null) return [];
  const { code, errors, cause } = error as { code?: unknown; errors?: unknown; cause?: unknown };
  return [
    ...(typeof code === "string" ? [code] : []),
    ...(Array.isArray(errors) ? errors.flatMap((inner) => codesOf(inner, depth + 1)) : []),
    ...codesOf(cause, depth + 1),
  ];
}

/**
 * Whether a failed request may have been billed: it was sent, and no answer came back. A request
 * that never left (NEVER_SENT) and one the provider answered with a status were not.
 */
function maybeBilled(error: unknown): boolean {
  if (error instanceof APIConnectionError) {
    // The SDK's own timeout carries no cause, so where it gave up is unknown.
    if (error instanceof APIConnectionTimeoutError) return true;
    const codes = codesOf(error.cause);
    return !(codes.length > 0 && codes.every((code) => NEVER_SENT.has(code)));
  }
  // Anthropic does not bill a request it answered with an error.
  if (error instanceof APIError && typeof error.status === "number") return false;
  // Nobody classified it, so nobody can say it was not billed.
  return true;
}

/**
 * How long to wait before the retry, or null when this failure does not deserve one. The rules
 * the SDK's retries followed: what the server says (x-should-retry), else request timeouts, lock
 * timeouts, rate limits and server errors; as long as retry-after asks when that is under a
 * minute, else half a second, less up to a quarter for jitter.
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
  return asked !== null && asked >= 0 && asked < 60_000 ? asked : backoff;
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const ms = Number.parseFloat(headers?.get("retry-after-ms") ?? "");
  if (Number.isFinite(ms)) return ms;
  const after = headers?.get("retry-after");
  if (!after) return null;
  const seconds = Number.parseFloat(after);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(after);
  return Number.isFinite(at) ? at - Date.now() : null;
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
 */
export function createAnthropicClient(apiKey: string, options: { fetch?: typeof fetch } = {}): LlmClient {
  const send = options.fetch ?? globalThis.fetch;
  const anthropic = new Anthropic({
    apiKey,
    maxRetries: 0,
    // The SDK turns any failure that reads as a timeout into an error with no cause, so a
    // connection never made (a network that swallows packets) would look like a request lost in
    // flight and be counted at its worst case. Passed on under its code alone, it stays itself.
    fetch: (url, init) =>
      send(url, init).catch((error: unknown) => {
        if (!codesOf(error).includes("UND_ERR_CONNECT_TIMEOUT")) throw error;
        throw Object.assign(new TypeError("fetch failed: the connection was never made"), { code: "UND_ERR_CONNECT_TIMEOUT" });
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
          // Aborted in flight: the request went out, and its answer will never be read. The abort
          // is the caller's own, not a provider fault, so it is rethrown untouched; wrapping it
          // would make a timeout look like an API failure.
          if (signal.aborted) {
            onLost();
            throw error;
          }
          if (maybeBilled(error)) onLost();
          const failure = classify(error);
          const delay = attempt < MAX_RETRIES && failure.kind === "retriable" ? retryDelayMs(error) : null;
          if (delay === null || Date.now() + delay >= sendBefore) throw failure;
          await pause(delay, signal);
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
