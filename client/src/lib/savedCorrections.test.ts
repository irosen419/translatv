import { describe, expect, it } from "vitest";
import type { GlossaryEntry } from "@translatv/shared";
import { fetchAs, SavedCorrections } from "./savedCorrections.js";

const che: GlossaryEntry = { source: "che", target: "hey", sourceDialect: "es-AR", targetDialect: "en-US" };
const pibe: GlossaryEntry = { source: "pibe", target: "kid", sourceDialect: "es-AR", targetDialect: "en-US" };
const daily: GlossaryEntry = { source: "the standup", target: "la daily", sourceDialect: "en-US", targetDialect: "es-AR" };

/** A pretend /api/me/glossary that remembers what was PUT and records every request. */
function fakeApi(entries: GlossaryEntry[]) {
  const state = { entries: [...entries] };
  const calls: Array<{ method: string; body?: unknown }> = [];
  let status = 200;
  let throwing = false;
  /** Runs between this client's read and its write, as a call ending elsewhere would. */
  let beforePut: (() => void) | null = null;
  const fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as { entries: GlossaryEntry[] }) : undefined;
    calls.push({ method, ...(body === undefined ? {} : { body }) });
    if (throwing) throw new TypeError("fetch failed");
    if (path !== "/api/me/glossary") return new Response("{}", { status: 404 });
    if (status !== 200) return new Response(JSON.stringify({ error: "INTERNAL" }), { status });
    if (method === "PUT" && body) {
      beforePut?.();
      state.entries = body.entries;
    }
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    fetch,
    calls,
    state,
    failWith: (code: number) => {
      status = code;
    },
    unreachable: () => {
      throwing = true;
    },
    onPut: (fn: () => void) => {
      beforePut = fn;
    },
  };
}

describe("SavedCorrections", () => {
  it("loads the saved list in its stored order", async () => {
    const api = fakeApi([che, pibe]);
    expect(await new SavedCorrections(api.fetch).load()).toEqual([che, pibe]);
  });

  it("loads null, not an empty list, when the list could not be read", async () => {
    const refused = fakeApi([che]);
    refused.failWith(500);
    expect(await new SavedCorrections(refused.fetch).load()).toBeNull();
    const down = fakeApi([che]);
    down.unreachable();
    expect(await new SavedCorrections(down.fetch).load()).toBeNull();
  });

  it("loads null for a body that is not a glossary", async () => {
    const api = fakeApi([che]);
    const odd = async () => new Response(JSON.stringify({ entries: "no" }), { status: 200 });
    expect(await new SavedCorrections(odd).load()).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("deletes one entry and keeps the rest in order", async () => {
    const api = fakeApi([che, pibe, daily]);
    expect(await new SavedCorrections(api.fetch).remove(pibe)).toEqual([che, daily]);
    expect(api.state.entries).toEqual([che, daily]);
  });

  // The list on screen can be older than the account's: a call that ended in another tab saved
  // corrections since it loaded. Writing back the list on screen would delete those.
  it("deletes from the list as it is NOW, not as it was when the screen loaded", async () => {
    const api = fakeApi([che]);
    const saved = new SavedCorrections(api.fetch);
    await saved.load();
    api.state.entries = [daily, che];
    expect(await saved.remove(che)).toEqual([daily]);
    expect(api.state.entries).toEqual([daily]);
  });

  it("matches the whole entry, so the same phrase in another direction stays", async () => {
    const other = { ...che, target: "oye", targetDialect: "es-ES" };
    const api = fakeApi([che, other]);
    expect(await new SavedCorrections(api.fetch).remove(che)).toEqual([other]);
  });

  it("writes nothing when the entry is already gone, and answers with the list as it is", async () => {
    const api = fakeApi([pibe]);
    expect(await new SavedCorrections(api.fetch).remove(che)).toEqual([pibe]);
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("answers null when the delete did not land", async () => {
    const api = fakeApi([che, pibe]);
    api.failWith(500);
    expect(await new SavedCorrections(api.fetch).remove(che)).toBeNull();
    const down = fakeApi([che]);
    down.unreachable();
    expect(await new SavedCorrections(down.fetch).remove(che)).toBeNull();
  });
});

// Tabs share one sign in (session.ts). A delete is a read and then a write, and between them
// another tab can move this one to another account.
describe("fetchAs", () => {
  it("lets a request through while the account is the one it was made for", async () => {
    const api = fakeApi([che]);
    const saved = new SavedCorrections(fetchAs("ana", () => "ana", api.fetch));
    expect(await saved.load()).toEqual([che]);
  });

  it("refuses a request once another account is signed in, before anything is sent", async () => {
    const api = fakeApi([che]);
    const saved = new SavedCorrections(fetchAs("ana", () => "ben", api.fetch));
    expect(await saved.load()).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it("stops a delete whose account changed between its read and its write", async () => {
    const api = fakeApi([che, pibe]);
    let who = "ana";
    const reading: typeof api.fetch = async (path, init) => {
      const response = await api.fetch(path, init);
      if ((init?.method ?? "GET") === "GET") who = "ben";
      return response;
    };
    const saved = new SavedCorrections(fetchAs("ana", () => who, reading));
    expect(await saved.remove(che)).toBeNull();
    expect(api.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(api.state.entries).toEqual([che, pibe]);
  });
});
