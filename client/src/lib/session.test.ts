import { describe, expect, it } from "vitest";
import type { AuthSession } from "@translatv/shared";
import {
  REFRESH_KEY,
  REFRESH_MARGIN_MS,
  SessionManager,
  SessionUnavailable,
  type SessionDeps,
  type TokenStore,
} from "./session.js";

const T0 = 1_800_000_000_000;
const ACCESS_MS = 15 * 60 * 1000;

function memoryStore(initial: Record<string, string> = {}): TokenStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Safari in private mode, an embedded webview, a user who blocked site data. */
const throwingStore: TokenStore = {
  getItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
  removeItem() {
    throw new Error("storage disabled");
  },
};

/**
 * A pretend server: rotates refresh tokens the way the real one does (each token works once), and
 * records every call so a test can assert what was sent.
 */
function fakeServer(clock: { now: number }) {
  let serial = 0;
  const live = new Set<string>();
  const calls: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = [];
  let offline = false;
  let gone = false;

  function session(): AuthSession {
    serial += 1;
    const refreshToken = `refresh-${serial}`;
    live.add(refreshToken);
    return {
      accessToken: `access-${serial}`,
      accessExpiresAt: clock.now + ACCESS_MS,
      refreshToken,
      user: { id: "u1", displayName: "Ana", isOwner: false },
    };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (offline) throw new TypeError("fetch failed");
    const path = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const authorization = (init?.headers as Record<string, string> | undefined)?.["authorization"];
    calls.push({ path, body, ...(authorization ? { authorization } : {}) });
    switch (path) {
      case "/api/auth/login":
        return body["password"] === "right password" ? json(200, session()) : json(401, { error: "INVALID_CREDENTIALS" });
      case "/api/auth/signup":
        return json(201, session());
      case "/api/auth/refresh": {
        const token = String(body["refreshToken"]);
        if (!live.has(token)) return json(401, { error: "INVALID_REFRESH" });
        live.delete(token);
        return json(200, session());
      }
      case "/api/auth/logout":
        live.delete(String(body["refreshToken"]));
        return new Response(null, { status: 204 });
      case "/api/account":
        if (gone || authorization !== `Bearer access-${serial}`) return json(401, { error: "UNAUTHENTICATED" });
        if (body["password"] !== "right password") return json(401, { error: "INVALID_CREDENTIALS" });
        live.clear();
        return new Response(null, { status: 204 });
      case "/api/thing":
        return authorization === `Bearer access-${serial}` ? json(200, { ok: true }) : json(401, { error: "UNAUTHENTICATED" });
      default:
        return json(404, {});
    }
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    live,
    setOffline: (value: boolean) => {
      offline = value;
    },
    /** The account deleted from another device: its tokens stop working, access and refresh. */
    deleteElsewhere: () => {
      gone = true;
      live.clear();
    },
  };
}

function setup(storage: TokenStore | null = memoryStore()) {
  const clock = { now: T0 };
  const server = fakeServer(clock);
  const manager = new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
  return { clock, server, manager, storage };
}

describe("signing in", () => {
  it("keeps the refresh token in localStorage under translatv.refresh, and the access token only in memory", async () => {
    const store = memoryStore();
    const { manager } = setup(store);
    expect(await manager.signIn("ana@example.test", "right password")).toEqual({ ok: true });
    expect(store.data[REFRESH_KEY]).toBe("refresh-1");
    expect(JSON.stringify(store.data)).not.toContain("access-1");
    expect(manager.state()).toEqual({ status: "signedIn", user: { id: "u1", displayName: "Ana", isOwner: false } });
  });

  it("reports the server's code for a refusal, and stores nothing", async () => {
    const store = memoryStore();
    const { manager } = setup(store);
    expect(await manager.signIn("ana@example.test", "wrong")).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(store.data[REFRESH_KEY]).toBeUndefined();
    expect(manager.state().status).toBe("signedOut");
  });

  it("reports NETWORK rather than a wrong password when the server cannot be reached", async () => {
    // Telling someone their password is wrong during an outage makes them change a right one.
    const { manager, server } = setup();
    server.setOffline(true);
    expect(await manager.signIn("ana@example.test", "right password")).toEqual({ ok: false, error: "NETWORK" });
  });

  it("signs up into a session the same way", async () => {
    const { manager, server } = setup();
    expect(await manager.signUp({ invite: "ABCD", email: "a@example.test", password: "x".repeat(10), displayName: "A" })).toEqual({ ok: true });
    expect(server.calls[0]?.body).toMatchObject({ invite: "ABCD", displayName: "A" });
    expect(manager.state().status).toBe("signedIn");
  });

  it("still works for the page's lifetime when storage throws", async () => {
    const { manager } = setup(throwingStore);
    expect(await manager.signIn("ana@example.test", "right password")).toEqual({ ok: true });
    expect(await manager.accessToken()).toBe("access-1");
  });
});

describe("after a reload", () => {
  it("reads as restoring while a stored refresh token is exchanged, then signed in", async () => {
    const store = memoryStore();
    const first = setup(store);
    await first.manager.signIn("ana@example.test", "right password");

    // A new page: same storage, same server, nothing in memory.
    const reloaded = new SessionManager({ fetch: first.server.fetch, storage: store, now: () => first.clock.now });
    expect(reloaded.state().status).toBe("restoring");
    await reloaded.restore();
    expect(reloaded.state().status).toBe("signedIn");
    // Rotated: the stored token is the new one.
    expect(store.data[REFRESH_KEY]).toBe("refresh-2");
  });

  it("signs out, and clears storage, when the stored token is refused", async () => {
    const store = memoryStore({ [REFRESH_KEY]: "revoked-long-ago" });
    const { manager } = setup(store);
    await manager.restore();
    expect(manager.state().status).toBe("signedOut");
    expect(store.data[REFRESH_KEY]).toBeUndefined();
  });

  it("keeps the stored token when the server is merely unreachable", async () => {
    const store = memoryStore({ [REFRESH_KEY]: "refresh-9" });
    const { manager, server } = setup(store);
    server.setOffline(true);
    await manager.restore();
    expect(store.data[REFRESH_KEY]).toBe("refresh-9");
    expect(manager.state().status).toBe("restoring");
  });
});

describe("accessToken", () => {
  it("hands back the token in memory while it has more than a minute left", async () => {
    const { manager, server, clock } = setup();
    await manager.signIn("ana@example.test", "right password");
    clock.now = T0 + ACCESS_MS - REFRESH_MARGIN_MS - 1;
    expect(await manager.accessToken()).toBe("access-1");
    expect(server.calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(0);
  });

  it("refreshes BEFORE expiry rather than sending a token about to lapse", async () => {
    const { manager, clock } = setup();
    await manager.signIn("ana@example.test", "right password");
    clock.now = T0 + ACCESS_MS - REFRESH_MARGIN_MS;
    expect(await manager.accessToken()).toBe("access-2");
  });

  it("makes ONE refresh for many callers at once, since a second would present a spent token", async () => {
    const { manager, server, clock } = setup();
    await manager.signIn("ana@example.test", "right password");
    clock.now = T0 + ACCESS_MS;
    const tokens = await Promise.all([manager.accessToken(), manager.accessToken(), manager.accessToken()]);
    expect(new Set(tokens)).toEqual(new Set(["access-2"]));
    expect(server.calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(1);
    expect(manager.state().status).toBe("signedIn");
  });

  it("forces a refresh when asked, for a caller that was just refused", async () => {
    const { manager } = setup();
    await manager.signIn("ana@example.test", "right password");
    expect(await manager.accessToken({ force: true })).toBe("access-2");
  });

  it("answers null when signed out", async () => {
    const { manager } = setup();
    expect(await manager.accessToken()).toBe(null);
  });

  it("throws SessionUnavailable, not null, when the server cannot be reached", async () => {
    const { manager, server, clock } = setup();
    await manager.signIn("ana@example.test", "right password");
    clock.now = T0 + ACCESS_MS;
    server.setOffline(true);
    await expect(manager.accessToken()).rejects.toBeInstanceOf(SessionUnavailable);
    expect(manager.state().status).toBe("signedIn");
  });
});

describe("two tabs of one browser", () => {
  /** What navigator.locks gives every tab of an origin: one queue per lock name. */
  function sharedLock(): NonNullable<SessionDeps["lock"]> {
    const tails = new Map<string, Promise<unknown>>();
    return <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
      const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn);
      tails.set(name, run.catch(() => undefined));
      return run;
    };
  }

  it("never present the same refresh token twice when both refresh at once", async () => {
    // Both tabs find one stored token on load. Presented twice, the second presentation is
    // exactly what theft looks like to the server, which then revokes the family and signs both
    // tabs out. The shared lock makes the second tab read the token the first one just stored.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const lock = sharedLock();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now, lock });
    expect(await tab().signIn("ana@example.test", "right password")).toEqual({ ok: true });

    const [first, second] = [tab(), tab()];
    await Promise.all([first.restore(), second.restore()]);

    const presented = server.calls.filter((c) => c.path === "/api/auth/refresh").map((c) => c.body["refreshToken"]);
    expect(presented).toHaveLength(2);
    expect(new Set(presented).size).toBe(2);
    expect(first.state().status).toBe("signedIn");
    expect(second.state().status).toBe("signedIn");
  });
});

describe("the scheduled refresh", () => {
  function scheduled(clockSkewMs: number) {
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const manager = new SessionManager({
      fetch: server.fetch,
      storage: memoryStore(),
      // The server issues expiries on ITS clock; this browser reads its own.
      now: () => clock.now + clockSkewMs,
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: () => {},
    });
    return { server, timers, manager };
  }

  it("runs a minute before the access token expires", async () => {
    const { server, timers, manager } = scheduled(0);
    await manager.signIn("ana@example.test", "right password");
    expect(timers.at(-1)?.ms).toBe(ACCESS_MS - REFRESH_MARGIN_MS);

    timers.at(-1)?.fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(1);
  });

  it("never schedules itself at 0 ms when this browser's clock runs ahead of the server's", async () => {
    // Twenty minutes fast: every expiry the server sends is already in this browser's past, so
    // expiry minus now is negative on every refresh. Floored only at 0, each refresh scheduled
    // the next one immediately, and a page load became a loop of rotations that stopped only
    // when the server's per address limit ran out (29 in 12 seconds, measured).
    const { server, timers, manager } = scheduled(20 * 60 * 1000);
    await manager.signIn("ana@example.test", "right password");
    for (let i = 0; i < 3; i += 1) {
      timers.at(-1)?.fn();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(timers.length).toBeGreaterThan(1);
    // The requirement, written out rather than read from MIN_REFRESH_DELAY_MS: a test comparing
    // the schedule to that constant stayed green with the constant set to 0, storm and all.
    expect(timers.every((timer) => timer.ms >= 60_000)).toBe(true);
    expect(server.calls.filter((c) => c.path === "/api/auth/refresh")).toHaveLength(3);
  });
});

describe("authorizedFetch", () => {
  it("refreshes and retries once on a 401", async () => {
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    // Another sign in moves the fake server on, so the access token in memory is now refused.
    await server.fetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password: "right password" }) });
    const response = await manager.authorizedFetch("/api/thing");
    expect(response.status).toBe(200);
    expect(server.calls.filter((c) => c.path === "/api/thing").map((c) => c.authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-3",
    ]);
  });
});

describe("signing out", () => {
  it("forgets locally and revokes on the server", async () => {
    const store = memoryStore();
    const { manager, server } = setup(store);
    await manager.signIn("ana@example.test", "right password");
    await manager.signOut();
    expect(store.data[REFRESH_KEY]).toBeUndefined();
    expect(manager.state()).toEqual({ status: "signedOut", user: null });
    expect(server.calls.at(-1)).toMatchObject({ path: "/api/auth/logout", body: { refreshToken: "refresh-1" } });
    expect(server.live.has("refresh-1")).toBe(false);
  });

  it("still signs out locally when the server cannot be reached", async () => {
    const store = memoryStore();
    const { manager, server } = setup(store);
    await manager.signIn("ana@example.test", "right password");
    server.setOffline(true);
    await manager.signOut();
    expect(store.data[REFRESH_KEY]).toBeUndefined();
    expect(manager.state().status).toBe("signedOut");
  });

  it("tells subscribers", async () => {
    const { manager } = setup();
    const seen: string[] = [];
    manager.subscribe((state) => seen.push(state.status));
    await manager.signIn("ana@example.test", "right password");
    await manager.signOut();
    expect(seen).toEqual(["signedIn", "signedOut"]);
  });
});

describe("deleting the account", () => {
  it("sends the password with the bearer, and on success forgets the session everywhere", async () => {
    const store = memoryStore();
    const { manager, server } = setup(store);
    await manager.signIn("ana@example.test", "right password");
    const outcome = await manager.deleteAccount("right password");
    expect(outcome).toEqual({ ok: true });
    expect(server.calls.at(-1)).toMatchObject({
      path: "/api/account",
      body: { password: "right password" },
      authorization: "Bearer access-1",
    });
    expect(store.data[REFRESH_KEY]).toBeUndefined();
    expect(manager.state()).toEqual({ status: "signedOut", user: null });
  });

  it("reports a wrong password once, without retrying it, and stays signed in", async () => {
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    const before = server.calls.length;
    const outcome = await manager.deleteAccount("wrong password");
    expect(outcome).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    // One request: a retry would spend a second lockout strike on the same typo.
    expect(server.calls.slice(before).filter((c) => c.path === "/api/account")).toHaveLength(1);
    expect(manager.state().status).toBe("signedIn");
  });

  it("signs out, rather than staying signed in, when the account is already gone", async () => {
    // Deleted from another device: the bearer is refused (UNAUTHENTICATED, not a wrong password),
    // and so is the refresh token. The tab used to keep its session for up to fifteen minutes.
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    server.deleteElsewhere();
    const before = server.calls.length;
    expect(await manager.deleteAccount("right password")).toEqual({ ok: false, error: "UNAUTHENTICATED" });
    expect(manager.state()).toEqual({ status: "signedOut", user: null });
    // Settled by one refresh, never by a second deletion attempt.
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/account", "/api/auth/refresh"]);
  });

  it("reports NETWORK when the server cannot be reached, and stays signed in", async () => {
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    server.setOffline(true);
    expect(await manager.deleteAccount("right password")).toEqual({ ok: false, error: "NETWORK" });
    expect(manager.state().status).toBe("signedIn");
  });
});
