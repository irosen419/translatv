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

const ACCOUNTS = {
  u1: { id: "u1", displayName: "Ana", isOwner: false },
  u2: { id: "u2", displayName: "Ben", isOwner: false },
} as const;
type AccountId = keyof typeof ACCOUNTS;

/**
 * A pretend server: rotates refresh tokens the way the real one does (each token works once), and
 * records every call so a test can assert what was sent. Two accounts, Ana (ana@example.test) and
 * Ben (ben@example.test), so a tab can be moved from one to the other the way a shared stored
 * refresh token moves it.
 */
function fakeServer(clock: { now: number }) {
  let serial = 0;
  const live = new Set<string>();
  /** Whose each token is. */
  const owner = new Map<string, AccountId>();
  const gone = new Set<AccountId>();
  const calls: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = [];
  let offline = false;
  let refreshOffline = false;
  let staleOnce = false;
  let held: Promise<void> | null = null;

  function session(account: AccountId = "u1"): AuthSession {
    serial += 1;
    const refreshToken = `refresh-${serial}`;
    const accessToken = `access-${serial}`;
    live.add(refreshToken);
    owner.set(refreshToken, account);
    owner.set(accessToken, account);
    return { accessToken, accessExpiresAt: clock.now + ACCESS_MS, refreshToken, user: ACCOUNTS[account] };
  }

  /** Every refresh token of `account` stops working, as a deletion or a revocation does. */
  function revoke(account: AccountId): void {
    for (const token of [...live]) if (owner.get(token) === account) live.delete(token);
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
        if (body["password"] !== "right password") return json(401, { error: "INVALID_CREDENTIALS" });
        return json(200, session(body["email"] === "ben@example.test" ? "u2" : "u1"));
      case "/api/auth/signup":
        return json(201, session());
      case "/api/auth/refresh": {
        if (refreshOffline) throw new TypeError("fetch failed");
        const token = String(body["refreshToken"]);
        if (!live.has(token)) return json(401, { error: "INVALID_REFRESH" });
        live.delete(token);
        const answer = json(200, session(owner.get(token)));
        if (held) await held;
        return answer;
      }
      case "/api/auth/logout":
        live.delete(String(body["refreshToken"]));
        return new Response(null, { status: 204 });
      case "/api/account": {
        if (staleOnce) {
          staleOnce = false;
          return json(401, { error: "UNAUTHENTICATED" });
        }
        // The real server's order: the bearer, then the account the request names, then the password.
        const account = owner.get(authorization?.replace(/^Bearer /, "") ?? "");
        if (!account || gone.has(account) || authorization !== `Bearer access-${serial}`) {
          return json(401, { error: "UNAUTHENTICATED" });
        }
        if (typeof body["userId"] !== "string") return json(400, { error: "INVALID_INPUT" });
        if (body["userId"] !== account) return json(409, { error: "ACCOUNT_MISMATCH" });
        if (body["password"] !== "right password") return json(401, { error: "INVALID_CREDENTIALS" });
        gone.add(account);
        revoke(account);
        return new Response(null, { status: 204 });
      }
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
    deleteElsewhere: (account: AccountId = "u1") => {
      gone.add(account);
      revoke(account);
    },
    isGone: (account: AccountId) => gone.has(account),
    /** Every refresh from now on fails to get through, while other requests still do. */
    setRefreshOffline: (value: boolean) => {
      refreshOffline = value;
    },
    /** The next bearer is refused once, as an expired one is, while the refresh token stays good. */
    refuseNextBearer: () => {
      staleOnce = true;
    },
    /**
     * Refreshes from now on are done at the server (the token rotated) but their answers stay on
     * the wire until the returned release() runs.
     */
    holdRefresh: () => {
      let release = () => {};
      held = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        held = null;
        release();
      };
    },
  };
}

function setup(storage: TokenStore | null = memoryStore()) {
  const clock = { now: T0 };
  const server = fakeServer(clock);
  const manager = new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
  return { clock, server, manager, storage };
}

describe("a refresh still on the wire", () => {
  it("cannot undo a sign out that lands before it answers", async () => {
    // Measured in review: Sign out shows while the page restores, and a click then was undone when
    // the restore's refresh answered. The answer put its token back and set the account, and the
    // tab went on as the account just signed out of, able to start a call, until its access token
    // ran out.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    await new SessionManager({ fetch: server.fetch, storage, now: () => clock.now }).signIn("ana@example.test", "right password");
    const tab = new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const release = server.holdRefresh();
    const restoring = tab.restore();
    await tab.signOut();
    release();
    await restoring;

    expect(tab.state()).toEqual({ status: "signedOut", user: null });
    expect(storage.data[REFRESH_KEY]).toBeUndefined();
  });

  it("cannot replace a sign in made while it was out", async () => {
    // Signed in as someone else before the old refresh answered, with no sign out between (the
    // test above has one): its answer is for the account the tab left.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    await new SessionManager({ fetch: server.fetch, storage, now: () => clock.now }).signIn("ana@example.test", "right password");
    const tab = new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const release = server.holdRefresh();
    const restoring = tab.restore();
    expect(await tab.signIn("ben@example.test", "right password")).toEqual({ ok: true });
    const bens = storage.data[REFRESH_KEY];
    release();
    await restoring;

    expect(tab.state().user?.id).toBe("u2");
    expect(storage.data[REFRESH_KEY]).toBe(bens);
  });
});

describe("a call's tokens", () => {
  it("are only ever the account the call was joined as, and say so when the tab moves", async () => {
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    const call = ana.callTokens();
    expect(await call.source({ force: false })).toBe("access-1");
    expect(call.moved()).toBe(false);
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");

    expect(await call.source({ force: true })).toBeNull();
    expect(call.moved()).toBe(true);
  });

  it("belong to the account the restore lands on, for a call begun while the session restores", async () => {
    // No account is shown yet when the call begins, so the first token settles it. Left unbound,
    // the call went on with whatever account a later refresh read (measured in review).
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    await tab().signIn("ana@example.test", "right password");
    const ana = tab();
    expect(ana.state().status).toBe("restoring");
    const call = ana.callTokens();
    expect(await call.source({ force: false })).not.toBeNull();
    expect(ana.state().user?.id).toBe("u1");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");

    expect(await call.source({ force: true })).toBeNull();
    expect(call.moved()).toBe(true);
  });

  it("end without saying the tab moved when it was signed out or deleted instead", async () => {
    // "This tab is now signed in to another account" is only true when it is. Counting every
    // null as a move put that sentence on the sign in screen after a sign out (measured in
    // review).
    for (const end of ["signOut", "deleted"] as const) {
      const clock = { now: T0 };
      const server = fakeServer(clock);
      const storage = memoryStore();
      const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
      const ana = tab();
      await ana.signIn("ana@example.test", "right password");
      const call = ana.callTokens();
      expect(await call.source({ force: false })).toBe("access-1");
      if (end === "signOut") {
        const other = tab();
        await other.restore();
        await other.signOut();
      } else {
        server.deleteElsewhere("u1");
      }

      expect(await call.source({ force: true })).toBeNull();
      expect(call.moved()).toBe(false);
    }
  });
});

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

  it("hands a call only the account it was joined as, and nothing once the tab holds another", async () => {
    // A reconnect after a long outage forces a refresh, which reads whichever account another tab
    // signed in to last. With that token the call rejoined as it, under this account's name, and
    // both accounts' call history and contacts gained a call one of them never had (measured in
    // review). null ends the call instead.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    expect(await ana.accessTokenFor("u1")).toBe("access-1");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");

    expect(await ana.accessTokenFor("u1", { force: true })).toBeNull();
    expect(ana.state().user?.id).toBe("u2");
  });

  it("hands a call nothing once the tab's own refresh has moved it, forced or not", async () => {
    // A dropped socket that had opened reconnects without force, and a call that outlives one
    // access token refreshes on its own, from the same shared storage. Checking the account only
    // on a forced refresh passed every test, the e2e included, and then gave that reconnect the
    // other account's token (measured in review).
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");
    clock.now = T0 + ACCESS_MS - REFRESH_MARGIN_MS;

    expect(await ana.accessTokenFor("u1")).toBeNull();
    expect(ana.state().user?.id).toBe("u2");
  });

  it("sends a request made while the session is still restoring, as the account it restores", async () => {
    // No account is shown yet, so there is none to hold the request to. Refused, a caller that
    // fetched during the restore would fail silently, with nothing sent (measured in review).
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    await new SessionManager({ fetch: server.fetch, storage, now: () => clock.now }).signIn("ana@example.test", "right password");
    const reloaded = new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const response = await reloaded.authorizedFetch("/api/thing");
    expect(response.status).toBe(200);
    expect(reloaded.state().user?.id).toBe("u1");
  });

  it("never sends or replays a request as another account", async () => {
    // Tabs share one stored refresh token, so the refresh after a 401 can land this tab on
    // whichever account another tab signed in to last. Replayed there, a write changed that
    // account's data (measured in review: its stored preferences). So can the refresh a token
    // about to expire gets on the way in, before anything is sent.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");

    let before = server.calls.length;
    const replayed = await ana.authorizedFetch("/api/thing", { method: "PUT" });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ error: "ACCOUNT_MISMATCH" });
    expect(ana.state().user?.id).toBe("u2");
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/thing", "/api/auth/refresh"]);

    const next = tab();
    await next.restore();
    await next.signOut();
    await next.signIn("ana@example.test", "right password");
    clock.now += ACCESS_MS;
    before = server.calls.length;
    const renewed = await ana.authorizedFetch("/api/thing", { method: "PUT" });
    expect(renewed.status).toBe(409);
    expect(ana.state().user?.id).toBe("u1");
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/auth/refresh"]);
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
  it("sends the password and the account it deletes with the bearer, and on success forgets the session everywhere", async () => {
    const store = memoryStore();
    const { manager, server } = setup(store);
    await manager.signIn("ana@example.test", "right password");
    const outcome = await manager.deleteAccount("right password", "u1");
    expect(outcome).toEqual({ ok: true });
    expect(server.calls.at(-1)).toMatchObject({
      path: "/api/account",
      body: { password: "right password", userId: "u1" },
      authorization: "Bearer access-1",
    });
    expect(store.data[REFRESH_KEY]).toBeUndefined();
    expect(manager.state()).toEqual({ status: "signedOut", user: null });
  });

  it("reports a wrong password once, without retrying it, and stays signed in", async () => {
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    const before = server.calls.length;
    const outcome = await manager.deleteAccount("wrong password", "u1");
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
    expect(await manager.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "UNAUTHENTICATED" });
    expect(manager.state()).toEqual({ status: "signedOut", user: null });
    // Settled by one refresh, never by a second deletion attempt.
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/account", "/api/auth/refresh"]);
  });

  it("stays signed in, with no second DELETE, when the bearer is refused but the refresh works", async () => {
    // An access token that expired between being read and being sent, or a server whose clock
    // runs ahead: the bearer is refused while the account is fine. The refresh settles that the
    // session is still good, so the person stays signed in, and their next try deletes.
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    server.refuseNextBearer();
    const before = server.calls.length;
    expect(await manager.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "UNAUTHENTICATED" });
    expect(manager.state().status).toBe("signedIn");
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/account", "/api/auth/refresh"]);
    expect(await manager.deleteAccount("right password", "u1")).toEqual({ ok: true });
  });

  it("never deletes the account another tab moved this one to, and never says to try again", async () => {
    // Tabs share one stored refresh token, so signing in as someone else in one tab moves every
    // other tab to that account at its next refresh. Measured in review against the real server:
    // Ana's tab was refused (her account deleted elsewhere), its refresh read Ben's token and
    // became Ben, the form said her sign in had expired, and trying again with the password the
    // two shared deleted Ben's account.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");
    server.deleteElsewhere("u1");

    const before = server.calls.length;
    expect(await ana.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "ACCOUNT_MISMATCH" });
    expect(ana.state().user?.id).toBe("u2");
    // Again, as "try again" would have had them do, from the form opened for Ana.
    expect(await ana.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "ACCOUNT_MISMATCH" });
    expect(server.isGone("u2")).toBe(false);
    // One DELETE, Ana's, refused on her bearer. The second try never left this tab: it holds Ben's
    // bearer now, and only the account the person confirmed is ever named with one.
    const deletes = server.calls.slice(before).filter((call) => call.path === "/api/account");
    expect(deletes.map((call) => call.body["userId"])).toEqual(["u1"]);
  });

  it("never sends another account's bearer when the token renewed on the way in belongs to it", async () => {
    // accessToken() renews a token about to expire before handing it over, so the tab can change
    // account inside deleteAccount before anything is sent. The check has to follow it: moved
    // before it, every other test passed (measured in review) and the DELETE went out as Ben.
    const clock = { now: T0 };
    const server = fakeServer(clock);
    const storage = memoryStore();
    const tab = () => new SessionManager({ fetch: server.fetch, storage, now: () => clock.now });
    const ana = tab();
    await ana.signIn("ana@example.test", "right password");
    const other = tab();
    await other.restore();
    await other.signOut();
    await other.signIn("ben@example.test", "right password");
    clock.now += ACCESS_MS;

    const before = server.calls.length;
    expect(await ana.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "ACCOUNT_MISMATCH" });
    expect(ana.state().user?.id).toBe("u2");
    expect(server.calls.slice(before).map((call) => call.path)).toEqual(["/api/auth/refresh"]);
  });

  it("says the server could not be reached, not that the sign in expired, when the refresh cannot get through", async () => {
    // "Expired, try again" promises the retry will work; with the refresh unreachable it fails the
    // same way again (measured in review).
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    server.refuseNextBearer();
    server.setRefreshOffline(true);
    expect(await manager.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "NETWORK" });
    expect(manager.state().status).toBe("signedIn");
  });

  it("reports NETWORK when the server cannot be reached, and stays signed in", async () => {
    const { manager, server } = setup();
    await manager.signIn("ana@example.test", "right password");
    server.setOffline(true);
    expect(await manager.deleteAccount("right password", "u1")).toEqual({ ok: false, error: "NETWORK" });
    expect(manager.state().status).toBe("signedIn");
  });
});
