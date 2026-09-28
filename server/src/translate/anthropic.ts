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
 * SDK level retries.
 *
 * The default is 2, which is right for a batch job and wrong for a live subtitle: three attempts
 * with backoff can consume the whole 6 second timeout before our own handler ever runs, and the
 * user gets a blank line instead of a fast, honest fallback to the original text. One retry
 * absorbs a single blip; beyond that, showing the original beats a late translation.
 */
export const MAX_RETRIES = 1;

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

export function createAnthropicClient(apiKey: string): LlmClient {
  const anthropic = new Anthropic({ apiKey, maxRetries: MAX_RETRIES });

  return {
    // The SDK's own retries each send the request again, and each may be billed.
    attempts: 1 + MAX_RETRIES,
    async complete({ system, user, signal }) {
      let response;
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
      } catch (error) {
        // An abort is our own timeout, not a provider fault. Rethrow it untouched so the caller
        // can tell the two apart; wrapping it would make a timeout look like an API failure.
        if (signal.aborted) throw error;
        throw classify(error);
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
