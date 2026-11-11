import { describe, expect, it } from "vitest";
import { SafetyApi, safetyRegistry } from "./safety.js";

type Handler = (method: string, path: string, body: unknown) => { status: number; body?: unknown };

/** A pretend server that records every request and answers through `handler`. */
function fake(handler: Handler) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let throwing = false;
  const fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, path, body });
    if (throwing) throw new TypeError("fetch failed");
    const answer = handler(method, path, body);
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls, unreachable: () => (throwing = true) };
}

const BLOCKED = { blocked: [{ contactId: "c1", displayName: "Ben", blockedAt: 5 }] };

describe("SafetyApi", () => {
  it("blocks by contactId and answers the list as it now stands", async () => {
    const server = fake(() => ({ status: 200, body: BLOCKED }));
    expect(await new SafetyApi(server.fetch).block("c1")).toEqual({ ok: true, value: BLOCKED });
    expect(server.calls).toEqual([{ method: "POST", path: "/api/me/blocks", body: { contactId: "c1" } }]);
  });

  it("unblocks with DELETE and the same body", async () => {
    const server = fake(() => ({ status: 200, body: { blocked: [] } }));
    expect(await new SafetyApi(server.fetch).unblock("c1")).toEqual({ ok: true, value: { blocked: [] } });
    expect(server.calls[0]).toEqual({ method: "DELETE", path: "/api/me/blocks", body: { contactId: "c1" } });
  });

  it("reports, sending details only when there are some, and alsoBlock as given", async () => {
    const server = fake(() => ({ status: 201, body: { id: "r1", blocked: true } }));
    const api = new SafetyApi(server.fetch);
    expect(await api.report({ contactId: "c1", reason: "hate", details: "  ", alsoBlock: true })).toEqual({
      ok: true,
      value: { id: "r1", blocked: true },
    });
    await api.report({ contactId: "c1", reason: "other", details: "words", alsoBlock: false });
    expect(server.calls.map((c) => c.body)).toEqual([
      { contactId: "c1", reason: "hate", alsoBlock: true },
      { contactId: "c1", reason: "other", details: "words", alsoBlock: false },
    ]);
  });

  it("answers the server's code on a refusal", async () => {
    const server = fake(() => ({ status: 429, body: { error: "RATE_LIMITED" } }));
    expect(await new SafetyApi(server.fetch).report({ contactId: "c1", reason: "hate", details: "", alsoBlock: false })).toEqual({
      ok: false,
      error: "RATE_LIMITED",
    });
  });

  it("answers NETWORK when the server cannot be reached, or answers something unreadable", async () => {
    const down = fake(() => ({ status: 200, body: BLOCKED }));
    down.unreachable();
    expect(await new SafetyApi(down.fetch).blocks()).toEqual({ ok: false, error: "NETWORK" });
    const garbled = fake(() => ({ status: 200, body: { nope: true } }));
    expect(await new SafetyApi(garbled.fetch).blocks()).toEqual({ ok: false, error: "NETWORK" });
  });

  it("reads one page of calls", async () => {
    const page = { calls: [{ id: "x", peer: { contactId: "c1", displayName: "Ben" }, startedAt: 1, endedAt: 2 }], nextCursor: null };
    const server = fake(() => ({ status: 200, body: page }));
    expect(await new SafetyApi(server.fetch).calls()).toEqual({ ok: true, value: page });
    expect(server.calls[0]?.path).toBe("/api/me/calls?limit=20");
  });

  it("lists and reviews reports as the owner", async () => {
    const report = {
      id: "r1",
      reason: "hate",
      details: null,
      status: "reviewed",
      createdAt: 1,
      reviewedAt: 2,
      reporter: null,
      reported: { userId: "u2", displayName: "Ben" },
    };
    const server = fake((method) => ({ status: 200, body: method === "GET" ? { reports: [report] } : report }));
    const api = new SafetyApi(server.fetch);
    expect(await api.ownerReports()).toEqual({ ok: true, value: { reports: [report] } });
    expect(await api.review("r1")).toEqual({ ok: true, value: report });
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /api/owner/reports", "POST /api/owner/reports/review"]);
  });
});

describe("safetyRegistry", () => {
  it("acts only as the account it was made for, and refuses once another is signed in", async () => {
    let signedIn: string | null = "ana";
    const requests: string[] = [];
    const session = {
      state: () => ({ user: signedIn === null ? null : { id: signedIn } }),
      authorizedFetch: async (path: string) => {
        requests.push(path);
        return new Response(JSON.stringify(BLOCKED), { status: 200 });
      },
    };
    const forAccount = safetyRegistry(session);
    expect(forAccount("ana")).toBe(forAccount("ana"));
    expect((await forAccount("ana").blocks()).ok).toBe(true);
    signedIn = "ben";
    expect(await forAccount("ana").block("c1")).toEqual({ ok: false, error: "ACCOUNT_MISMATCH" });
    expect(requests).toEqual(["/api/me/blocks"]);
  });
});
