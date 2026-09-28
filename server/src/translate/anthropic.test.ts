// The Anthropic adapter against a fake fetch, and against loopback servers that fail the way a
// network does: the real SDK throughout, and the real fetch for the loopback cases. No key, no
// spend, and nothing leaves 127.0.0.1.
//
// What is pinned here is what the adapter tells the service about each request, because the
// ledger rests on it. A request the provider answered with an error was not billed, and neither
// was one that never left this machine, so neither is reported. A request that was sent and then
// lost its answer may have been billed, and is reported once (onLost), before any retry goes out.
// No request is started at or after the caller's deadline: a retry the SDK used to send after the
// caller had been told TIMED_OUT was paid for and seen by nobody (measured in review: a 429 asking
// for ten seconds put the retry four seconds past the timeout).

import { channel } from "node:diagnostics_channel";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
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

/** One call through the adapter, over `fetch`, or over the real fetch when it is undefined. */
function complete(
  fetch: typeof globalThis.fetch | undefined,
  options: { sendBefore?: number; signal?: AbortSignal; baseURL?: string } = {},
) {
  let lost = 0;
  const client = createAnthropicClient("sk-ant-fake-not-a-key", { fetch, baseURL: options.baseURL });
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

const servers: net.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
    if (server instanceof http.Server) server.closeAllConnections();
  }
});

/** Listen on a free loopback port. The server is closed after the test. */
async function listen(server: net.Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A loopback port nothing listens on, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A server that resets each connection as the client's TLS handshake begins. */
async function resetsHandshake() {
  let connections = 0;
  const port = await listen(
    net.createServer((socket) => {
      connections += 1;
      socket.once("data", () => socket.resetAndDestroy());
    }),
  );
  return { baseURL: `https://127.0.0.1:${port}`, connections: () => connections };
}

/** A server that reads each request in full, counts it, then fails its connection by `fail`, unanswered. */
async function failsAfterRequest(fail: (socket: net.Socket) => void) {
  let requests = 0;
  const port = await listen(
    net.createServer((socket) => {
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
        const end = received.indexOf("\r\n\r\n");
        if (end < 0) return;
        const length = Number(/content-length: *(\d+)/i.exec(received.slice(0, end))?.[1] ?? 0);
        if (received.length - end - 4 < length) return;
        requests += 1;
        received = "";
        fail(socket);
      });
    }),
  );
  return { baseURL: `http://127.0.0.1:${port}`, requests: () => requests };
}

/**
 * A failure played the way undici reports one (measured on Node 22): it publishes the error for
 * each request it failed, noting first any whose headers it wrote, then fetch rejects with the
 * error as its cause.
 */
function undiciFailure(error: Error, requests: Array<"written" | "unwritten">): Answer {
  return () => {
    for (const state of requests) {
      const request = {};
      if (state === "written") channel("undici:client:sendHeaders").publish({ request, headers: "", socket: null });
      channel("undici:request:error").publish({ request, error });
    }
    return Promise.reject(new TypeError("fetch failed", { cause: error }));
  };
}

describe("the Anthropic adapter", () => {
  it("asks for at most MAX_OUTPUT_TOKENS, the figure a lost request's worst case is priced on", async () => {
    const { fetch, requests } = fakeFetch([ok]);
    const { result } = complete(fetch);
    await expect(result).resolves.toEqual({ text: "hola", inputTokens: 812, outputTokens: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body["max_tokens"]).toBe(MAX_OUTPUT_TOKENS);
  });

  it("reports nothing for a request never sent: a connection refused", async () => {
    // Nothing was sent, so nothing was billed. Reported as lost, each was logged at its worst case
    // and counted by the caps: an outage filled a room's cap in 182 lines with nothing spent, and
    // the room stayed refused after the network came back (measured in review).
    const { result, lost } = complete(undefined, { baseURL: `http://127.0.0.1:${await closedPort()}` });
    await expect(result).rejects.toMatchObject({ reason: "connection" });
    expect(lost()).toBe(0);
  });

  it("reports nothing for a request never sent because its TLS handshake failed", async () => {
    // Round 2 of review found certificate failures counted as sent, with the same lockout. The
    // certificate case needs a key pair this public repository will not carry; these two fail the
    // same handshake without one: a server that does not speak TLS, and a reset.
    let requests = 0;
    const port = await listen(
      http.createServer((_request, response) => {
        requests += 1;
        response.end();
      }),
    );
    const plain = complete(undefined, { baseURL: `https://127.0.0.1:${port}` });
    await expect(plain.result).rejects.toMatchObject({ reason: "connection" });
    expect(requests).toBe(0);
    expect(plain.lost()).toBe(0);

    const server = await resetsHandshake();
    const reset = complete(undefined, { baseURL: server.baseURL });
    await expect(reset.result).rejects.toMatchObject({ reason: "connection" });
    expect(server.connections()).toBe(1 + MAX_RETRIES);
    expect(reset.lost()).toBe(0);
  });

  it("reports each request that was sent and lost its answer, once, though a reset during the handshake carries the same code", async () => {
    // The reset here carries ECONNRESET, as the one during the handshake above does: no error code
    // tells the two apart. The close carries UND_ERR_SOCKET.
    for (const fail of [(socket: net.Socket) => socket.resetAndDestroy(), (socket: net.Socket) => socket.end()]) {
      const server = await failsAfterRequest(fail);
      const { result, lost } = complete(undefined, { baseURL: server.baseURL });
      await expect(result).rejects.toMatchObject({ reason: "connection" });
      expect(server.requests()).toBe(1 + MAX_RETRIES);
      expect(lost()).toBe(1 + MAX_RETRIES);
    }
  });

  it("reports nothing for a connection that timed out before it was made", async () => {
    // What a network that swallows packets gives, after 10 s an attempt: too slow for a unit test,
    // so undici's report is played here. Its text reads as a timeout, and the SDK turns anything
    // that does into an error that does not say where the request failed, which would count it as
    // lost in flight.
    const timedOut = Object.assign(
      new Error("Connect Timeout Error (attempted address: api.anthropic.com:443, timeout: 10000ms)"),
      { name: "ConnectTimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" },
    );
    const { fetch, requests } = fakeFetch([undiciFailure(timedOut, ["unwritten"]), undiciFailure(timedOut, ["unwritten"])]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ reason: "connection" });
    expect(requests).toHaveLength(2);
    expect(lost()).toBe(0);
  });

  it("reports a request as lost when the error that failed it also failed one that was written", async () => {
    // A connection that fails takes its whole queue with it, under one error. Whichever request
    // the error is read for, one of them was sent.
    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const { fetch } = fakeFetch([undiciFailure(reset, ["unwritten", "written"]), undiciFailure(reset, ["written", "unwritten"])]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ reason: "connection" });
    expect(lost()).toBe(2);
  });

  it("reports a failure undici never said anything about as lost: nobody can say it was not sent", async () => {
    // A fake fetch's failure, or fetch refusing a URL before undici saw it. Its code is no
    // evidence either way.
    const { fetch, requests } = fakeFetch([connectionFailure("ECONNREFUSED"), connectionFailure("ECONNREFUSED")]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ reason: "connection" });
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

  it("reports a lost request before its retry goes out, and even when the retry then answers", async () => {
    // Its row must be on disk before the next request is issued (CLAUDE.md). Reported only when
    // the call settled, the retry went out with no row, and a shutdown during the retry left one
    // row for two requests (measured in review).
    let lostWhenRetried: number | undefined;
    const { fetch } = fakeFetch([
      connectionFailure("UND_ERR_SOCKET"),
      () => {
        lostWhenRetried = lost();
        return ok();
      },
    ]);
    const { result, lost } = complete(fetch);
    await expect(result).resolves.toMatchObject({ inputTokens: 812, outputTokens: 7 });
    expect(lostWhenRetried).toBe(1);
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

  it("sends no retry once the deadline has passed, even when the wait before it ends late", async () => {
    // A busy event loop ends the wait late: here a 1.1 s stall lands in a 100 ms wait. Checked
    // only when the wait was planned, the retry went out after the deadline (measured in review).
    let failedAt = 0;
    const stalls: Answer = () => {
      failedAt = Date.now();
      setTimeout(() => {
        const until = Date.now() + 1_100;
        while (Date.now() < until) {
          // a synchronous stall of the event loop
        }
      }, 20);
      return status(500, { "retry-after-ms": "100" })();
    };
    const { fetch, requests } = fakeFetch([stalls, ok]);
    const { result } = complete(fetch, { sendBefore: Date.now() + 1_000 });
    await expect(result).rejects.toMatchObject({ reason: "status_500" });
    expect(requests).toHaveLength(1);
    // Only a wait that was planned and then woke late gets here after the stall.
    expect(Date.now() - failedAt).toBeGreaterThanOrEqual(1_100);
  });

  it("retries once when the wait fits before the deadline, as long as the provider asks", async () => {
    const { fetch, requests } = fakeFetch([status(429, { "retry-after-ms": "40" }), ok]);
    const { result } = complete(fetch, { sendBefore: Date.now() + 6_000 });
    await expect(result).resolves.toMatchObject({ text: "hola" });
    expect(requests).toHaveLength(2);
    expect((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(35);
  });

  it("retries what the SDK retried: request timeouts, lock timeouts, rate limits, server errors", async () => {
    for (const code of [408, 409, 429, 500, 529]) {
      const { fetch, requests } = fakeFetch([status(code, { "retry-after-ms": "1" }), ok]);
      const { result } = complete(fetch);
      await expect(result).resolves.toMatchObject({ text: "hola" });
      expect(requests).toHaveLength(2);
    }
  });

  it("retries whatever the server says to, even a 400, as the SDK did", async () => {
    const { fetch, requests } = fakeFetch([status(400, { "x-should-retry": "true", "retry-after-ms": "1" }), ok]);
    const { result } = complete(fetch);
    await expect(result).resolves.toMatchObject({ text: "hola" });
    expect(requests).toHaveLength(2);
  });

  it("waits half a second, less jitter, when the provider names no wait, or a wait of zero", async () => {
    for (const headers of [{}, { "retry-after-ms": "0" }, { "retry-after": "0" }]) {
      const { fetch, requests } = fakeFetch([status(500, headers), ok]);
      const { result } = complete(fetch);
      await expect(result).resolves.toMatchObject({ text: "hola" });
      // 375 ms at the least, less a millisecond of timer rounding.
      expect((requests[1]?.at ?? 0) - (requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(374);
    }
  });

  it("reads retry-after when retry-after-ms is zero, and as a date, as the SDK did", async () => {
    // Each asks for a wait that ends after the deadline, so neither is retried. A reading that
    // missed the header would wait the half second backoff and retry in time.
    const inFourSeconds = new Date(Date.now() + 4_000).toUTCString();
    for (const headers of [{ "retry-after-ms": "0", "retry-after": "3" }, { "retry-after": inFourSeconds }]) {
      const { fetch, requests } = fakeFetch([status(429, headers), ok]);
      const { result } = complete(fetch, { sendBefore: Date.now() + 1_500 });
      await expect(result).rejects.toMatchObject({ reason: "rate_limit" });
      expect(requests).toHaveLength(1);
    }
  });

  it("does not retry an answer it could not read, and reports it lost: it was answered, so billed", async () => {
    const unreadable: Answer = () =>
      Promise.resolve(new Response("not json {", { status: 200, headers: { "content-type": "application/json" } }));
    const { fetch, requests } = fakeFetch([unreadable, ok]);
    const { result, lost } = complete(fetch);
    await expect(result).rejects.toMatchObject({ reason: "unknown" });
    expect(requests).toHaveLength(1);
    expect(lost()).toBe(1);
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
