// The Anthropic adapter against a fake fetch: the real SDK, no network, no key, no spend.
//
// What is pinned here is what the adapter tells the service about each request, because the
// ledger rests on it. A request the provider answered with an error was not billed, and neither
// was one that never left this machine (a host that did not resolve, a connection refused), so
// neither is reported. A request that was sent and then lost its answer may have been billed, and
// is reported once (onLost). No request is sent at or after the caller's deadline: a retry the
// SDK used to send after the caller had been told TIMED_OUT was paid for and seen by nobody
// (measured in review: a 429 asking for ten seconds put the retry four seconds past the timeout).

import { describe, expect, it } from "vitest";
import { LlmFailure, MAX_OUTPUT_TOKENS } from "./TranslationService.js";
import { createAnthropicClient, MAX_RETRIES } from "./anthropic.js";

type Answer = () => Promise<Response>;

const ANSWER = {
  id: "msg_fake",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [{ type: "text", text: "hola" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 812, output_tokens: 7 },
};

const ok = (): Promise<Response> =>
  Promise.resolve(new Response(JSON.stringify(ANSWER), { status: 200, headers: { "content-type": "application/json" } }));

const status =
  (code: number, headers: Record<string, string> = {}): Answer =>
  () =>
    Promise.resolve(
      new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "fake" } }), {
        status: code,
        headers: { "content-type": "application/json", ...headers },
      }),
    );

/** How undici reports a connection that failed: TypeError("fetch failed") over the system error. */
const connectionFailure =
  (code: string): Answer =>
  () =>
    Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error(`${code} fake`), { code }) }));

/** A fake fetch that plays `answers` in order, one per request, and records each request. */
function fakeFetch(answers: Answer[]) {
  const requests: Array<{ at: number; body: Record<string, unknown> }> = [];
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push({ at: Date.now(), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const answer = answers[requests.length - 1];
    if (!answer) throw new Error("the fake fetch ran out of answers");
    return answer();
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

function complete(fetch: typeof globalThis.fetch, options: { sendBefore?: number; signal?: AbortSignal } = {}) {
  let lost = 0;
  const client = createAnthropicClient("sk-ant-fake-not-a-key", { fetch });
  const result = client.complete({
    system: "system",
    user: "user",
    signal: options.signal ?? new AbortController().signal,
    sendBefore: options.sendBefore ?? Date.now() + 60_000,
    onLost: () => {
      lost += 1;
    },
  });
  return { result, lost: () => lost };
}

describe("the Anthropic adapter", () => {
  it("asks for at most MAX_OUTPUT_TOKENS, the figure a lost request's worst case is priced on", async () => {
    const { fetch, requests } = fakeFetch([ok]);
    const { result } = complete(fetch);
    await expect(result).resolves.toEqual({ text: "hola", inputTokens: 812, outputTokens: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body["max_tokens"]).toBe(MAX_OUTPUT_TOKENS);
  });

  it("reports nothing for a request that never left: a host that did not resolve, a connection refused", async () => {
    // Nothing was sent, so nothing was billed. Reported as lost, each of these was logged at its
    // worst case and counted by the caps: an outage filled a room's cap in 182 lines, and would
    // fill the daily cap for every room in about 1,200, with nothing spent (measured in review).
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH"]) {
      const { fetch, requests } = fakeFetch([connectionFailure(code), connectionFailure(code)]);
      const { result, lost } = complete(fetch);
      await expect(result).rejects.toMatchObject({ reason: "connection" });
      expect(requests).toHaveLength(1 + MAX_RETRIES);
      expect(lost()).toBe(0);
    }
  });

  it("reports nothing for a connection that timed out before it was made", async () => {
    // A network that swallows packets (a partition, a firewall dropping them) ends every attempt
    // in undici's connect timeout: nothing was sent. The SDK turns anything that reads as a timeout
    // into an error with no cause, so the adapter has to catch this one before the SDK sees it, or
    // such an outage fills the caps with nothing spent, as a refused connection did.
    const connectTimeout: Answer = () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)"), {
            code: "UND_ERR_CONNECT_TIMEOUT",
          }),
        }),
      );
    const { fetch, requests } = fakeFetch([connectTimeout, connectTimeout]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ reason: "connection" });
    expect(requests).toHaveLength(2);
    expect(lost()).toBe(0);
  });

  it("reports a failure as lost unless every error beneath it says the request never left", async () => {
    // Happy eyeballs tries more than one address and aggregates the failures. One refused address
    // does not prove the other never carried the request.
    const mixed: Answer = () =>
      Promise.reject(
        new TypeError("fetch failed", {
          cause: new AggregateError([
            Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
            Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
          ]),
        }),
      );
    const { fetch } = fakeFetch([mixed, ok]);
    const { result, lost } = complete(fetch);
    await expect(result).resolves.toMatchObject({ text: "hola" });
    expect(lost()).toBe(1);
  });

  it("reports each request that was sent and lost its answer, once", async () => {
    const { fetch, requests } = fakeFetch([connectionFailure("UND_ERR_SOCKET"), connectionFailure("ECONNRESET")]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toBeInstanceOf(LlmFailure);
    expect(requests).toHaveLength(2);
    expect(lost()).toBe(2);
  });

  it("reports a request the SDK timed out as lost: its timeout error does not say where it gave up", async () => {
    // Anything that reads as a timeout becomes APIConnectionTimeoutError, with no cause, so a
    // connect timeout and a read timeout look alike. Counted lost: the safe direction.
    const { fetch, requests } = fakeFetch([connectionFailure("UND_ERR_HEADERS_TIMEOUT timed out"), ok]);
    const { result, lost } = complete(fetch);
    await expect(result).resolves.toMatchObject({ text: "hola" });
    expect(requests).toHaveLength(2);
    expect(lost()).toBe(1);
  });

  it("reports a lost request even when the retry then answers", async () => {
    const { fetch } = fakeFetch([connectionFailure("UND_ERR_SOCKET"), ok]);
    const { result, lost } = complete(fetch);
    await expect(result).resolves.toMatchObject({ inputTokens: 812, outputTokens: 7 });
    expect(lost()).toBe(1);
  });

  it("reports nothing for an error the provider answered with: a failed request is not billed", async () => {
    const { fetch, requests } = fakeFetch([status(500), status(529)]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ kind: "retriable" });
    expect(requests).toHaveLength(2);
    expect(lost()).toBe(0);
  });

  it("sends no retry that would start at or after the deadline", async () => {
    const { fetch, requests } = fakeFetch([status(429, { "retry-after": "10" }), ok]);
    const { result, lost } = complete(fetch, { sendBefore: Date.now() + 6_000 });
    await expect(result).rejects.toMatchObject({ reason: "rate_limit" });
    expect(requests).toHaveLength(1);
    expect(lost()).toBe(0);
  });

  it("retries once when the wait fits before the deadline, as long as the provider asks", async () => {
    const { fetch, requests } = fakeFetch([status(429, { "retry-after-ms": "40" }), ok]);
    const { result } = complete(fetch, { sendBefore: Date.now() + 6_000 });
    await expect(result).resolves.toMatchObject({ text: "hola" });
    expect(requests).toHaveLength(2);
    expect((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(35);
  });

  it("does not retry what the provider says not to, a request it refused as malformed, or one too large", async () => {
    // 413 is classified retriable like any other status the adapter does not name, so only the
    // retry rules keep it from going out twice.
    for (const answer of [status(500, { "x-should-retry": "false" }), status(400), status(413)]) {
      const { fetch, requests } = fakeFetch([answer, ok]);
      const { result } = complete(fetch);
      await expect(result).rejects.toBeInstanceOf(LlmFailure);
      expect(requests).toHaveLength(1);
    }
  });

  it("reports a request in flight when the caller aborts it: it was sent, and its answer will never be read", async () => {
    const controller = new AbortController();
    const hang: Answer = () => new Promise<Response>(() => undefined);
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        void hang();
      })) as typeof globalThis.fetch;
    const { result, lost } = complete(fetch, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(result).rejects.toBeDefined();
    expect(lost()).toBe(1);
  });

  it("sends nothing more, and reports nothing, when aborted while waiting to retry", async () => {
    const controller = new AbortController();
    const { fetch, requests } = fakeFetch([status(500, { "retry-after-ms": "200" }), ok]);
    const { result, lost } = complete(fetch, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(requests).toHaveLength(1);
    expect(lost()).toBe(0);
  });
});
