import { describe, expect, it } from "vitest";
import { PreferenceSync } from "./preferences.js";

/** A pretend /api/me/preferences that remembers what was PUT and records every request. */
function fakeApi(stored: { dialect: string | null; uiDialect: string | null } = { dialect: null, uiDialect: null }) {
  const state = { ...stored };
  const calls: Array<{ method: string; body?: unknown }> = [];
  let failing = false;
  const fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET";
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
    calls.push({ method, ...(body === undefined ? {} : { body }) });
    if (failing) throw new TypeError("fetch failed");
    if (path !== "/api/me/preferences") return new Response("{}", { status: 404 });
    if (method === "PUT") Object.assign(state, body as object);
    return new Response(JSON.stringify(state), { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    fetch,
    calls,
    state,
    fail: () => {
      failing = true;
    },
  };
}

describe("PreferenceSync", () => {
  it("loads the stored dialect", async () => {
    const api = fakeApi({ dialect: "es-AR", uiDialect: "es-AR" });
    const sync = new PreferenceSync(api.fetch);
    expect(await sync.load()).toEqual({ dialect: "es-AR", uiDialect: "es-AR" });
  });

  it("saves a change as both the call dialect and the interface dialect", async () => {
    const api = fakeApi();
    const sync = new PreferenceSync(api.fetch);
    await sync.load();
    await sync.changed("es-MX");
    expect(api.state).toEqual({ dialect: "es-MX", uiDialect: "es-MX" });
  });

  it("does not save the value it just loaded, or the same value twice", async () => {
    const api = fakeApi({ dialect: "es-AR", uiDialect: "es-AR" });
    const sync = new PreferenceSync(api.fetch);
    await sync.load();
    await sync.changed("es-AR");
    await sync.changed("en-US");
    await sync.changed("en-US");
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("saves nothing before the stored value has loaded, so a detected default cannot overwrite it", async () => {
    const api = fakeApi({ dialect: "es-AR", uiDialect: "es-AR" });
    const sync = new PreferenceSync(api.fetch);
    await sync.changed("en-US");
    expect(api.calls).toEqual([]);
    expect(api.state.dialect).toBe("es-AR");
  });

  it("answers null and saves nothing when the server cannot be reached or answers nonsense", async () => {
    const api = fakeApi();
    api.fail();
    const sync = new PreferenceSync(api.fetch);
    expect(await sync.load()).toBeNull();
    const nonsense = new PreferenceSync(async () => new Response(JSON.stringify({ dialect: "xx" }), { status: 200 }));
    expect(await nonsense.load()).toBeNull();
  });

  it("forgets what it loaded on reset, for the next account to sign in", async () => {
    const api = fakeApi({ dialect: "es-AR", uiDialect: "es-AR" });
    const sync = new PreferenceSync(api.fetch);
    await sync.load();
    sync.reset();
    await sync.changed("en-US");
    expect(api.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });
});
