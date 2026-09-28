// /api/auth and /api/invites over real HTTP: status codes, error codes, body limits, and the per
// IP limits. The rules themselves are proved in service.test.ts; this proves the mapping.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIMITS } from "@translatv/shared";
import type { Config } from "../config.js";
import { createApp } from "../http.js";
import { AccountService } from "../account/service.js";
import { openStore, type Store } from "../store/index.js";
import { AuthService } from "./service.js";

const PASSWORD = randomBytes(12).toString("hex");

let server: Server;
let base: string;
let store: Store;
let auth: AuthService;
let account: AccountService;

function config(): Config {
  return {
    port: 0,
    repoRoot: tmpdir(),
    allowedOrigins: [],
    anthropicApiKey: null,
    authSecret: null,
    signupMode: "invite",
    ownerEmail: "owner@example.test",
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    userDailyCapUsd: 1,
    iceServers: [],
    isProduction: false,
    trustProxy: false,
    dataDir: tmpdir(),
    databasePath: ":memory:",
  };
}

beforeEach(async () => {
  store = openStore({ path: ":memory:" });
  auth = new AuthService(store, {
    secret: randomBytes(32).toString("hex"),
    signupMode: "invite",
    ownerEmail: "owner@example.test",
  });
  account = new AccountService(store);
  server = createServer(createApp(config(), join(tmpdir(), "translatv-no-such-dist"), undefined, auth, account));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signup(email: string) {
  const invite = auth.createInvite(null, Date.now());
  const response = await post("/api/auth/signup", {
    invite: invite.code,
    email,
    password: PASSWORD,
    displayName: email.split("@")[0],
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

describe("POST /api/auth/signup", () => {
  it("answers 201 with a session", async () => {
    const { response, body } = await signup("ana@example.test");
    expect(response.status).toBe(201);
    expect(typeof body.accessToken).toBe("string");
    expect(typeof body.refreshToken).toBe("string");
    expect(typeof body.accessExpiresAt).toBe("number");
    expect(body.user).toMatchObject({ displayName: "ana", isOwner: false });
    // Never cached anywhere between here and the client.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 403 INVITE_INVALID with no invite", async () => {
    const response = await post("/api/auth/signup", {
      email: "ana@example.test",
      password: PASSWORD,
      displayName: "Ana",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "INVITE_INVALID" });
  });

  it("answers 400 INVALID_INPUT for a body that is not JSON, as a code rather than an HTML page", async () => {
    const response = await post("/api/auth/signup", "{not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("refuses a body over the limit", async () => {
    const response = await post("/api/auth/signup", { email: "a@example.test", password: "x".repeat(20_000) });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "INVALID_INPUT" });
  });
});

describe("POST /api/auth/login", () => {
  it("answers 200 with a session, and 401 INVALID_CREDENTIALS otherwise", async () => {
    await signup("ana@example.test");
    const good = await post("/api/auth/login", { email: "ana@example.test", password: PASSWORD });
    expect(good.status).toBe(200);
    const bad = await post("/api/auth/login", { email: "ana@example.test", password: "wrong wrong" });
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("is rate limited per address, before any password is checked", async () => {
    let limited: Response | null = null;
    for (let i = 0; i < 30 && !limited; i += 1) {
      const response = await post("/api/auth/login", { email: `n${i}@example.test`, password: "wrong wrong" });
      if (response.status === 429) limited = response;
    }
    expect(limited).not.toBe(null);
    expect(await limited?.json()).toEqual({ error: "RATE_LIMITED" });
  });
});

describe("POST /api/auth/refresh and /logout", () => {
  it("rotates, and refuses the spent token with 401 INVALID_REFRESH", async () => {
    const { body } = await signup("ana@example.test");
    const first = await post("/api/auth/refresh", { refreshToken: body.refreshToken });
    expect(first.status).toBe(200);
    const replay = await post("/api/auth/refresh", { refreshToken: body.refreshToken });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "INVALID_REFRESH" });
  });

  it("logs out with 204 whether or not the token was known", async () => {
    const { body } = await signup("ana@example.test");
    expect((await post("/api/auth/logout", { refreshToken: body.refreshToken })).status).toBe(204);
    expect((await post("/api/auth/logout", { refreshToken: "never issued" })).status).toBe(204);
    expect((await post("/api/auth/refresh", { refreshToken: body.refreshToken })).status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("answers the signed in user for a valid bearer", async () => {
    const { body } = await signup("ana@example.test");
    const response = await fetch(`${base}/api/auth/me`, {
      headers: { authorization: `Bearer ${String(body.accessToken)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: body.user });
  });

  it("answers 401 UNAUTHENTICATED with no bearer or a bad one", async () => {
    for (const headers of [{}, { authorization: "Bearer nope.nope" }, { authorization: "Basic abc" }]) {
      const response = await fetch(`${base}/api/auth/me`, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    }
  });
});

describe("POST /api/invites", () => {
  it("mints a single use code for the owner", async () => {
    const { body } = await signup("owner@example.test");
    const response = await post("/api/invites", {}, { authorization: `Bearer ${String(body.accessToken)}` });
    expect(response.status).toBe(201);
    const invite = (await response.json()) as { code: string; expiresAt: number };
    expect(invite.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    const used = await post("/api/auth/signup", {
      invite: invite.code,
      email: "ben@example.test",
      password: PASSWORD,
      displayName: "Ben",
    });
    expect(used.status).toBe(201);
  });

  it("refuses anyone who is not the owner with 403 FORBIDDEN", async () => {
    const { body } = await signup("ana@example.test");
    const response = await post("/api/invites", {}, { authorization: `Bearer ${String(body.accessToken)}` });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("refuses an anonymous caller with 401", async () => {
    expect((await post("/api/invites", {})).status).toBe(401);
  });
});

describe("the retired admin login", () => {
  it("is gone", async () => {
    const response = await post("/auth/login", { password: PASSWORD });
    expect(response.status).not.toBe(200);
  });
});

function send(method: string, path: string, token: unknown, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(typeof token === "string" ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("/api/me", () => {
  it("answers 401 UNAUTHENTICATED on every route without a bearer", async () => {
    for (const [method, path] of [
      ["GET", "/api/me/preferences"],
      ["PUT", "/api/me/preferences"],
      ["GET", "/api/me/glossary"],
      ["PUT", "/api/me/glossary"],
      ["GET", "/api/me/calls"],
      ["GET", "/api/me/contacts"],
      ["DELETE", "/api/account"],
    ] as const) {
      const response = await send(method, path, null, method === "GET" ? undefined : {});
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
    }
  });

  it("round trips preferences", async () => {
    const { body } = await signup("ana@example.test");
    const token = body.accessToken;
    expect(await (await send("GET", "/api/me/preferences", token)).json()).toEqual({ dialect: null, uiDialect: null });
    const put = await send("PUT", "/api/me/preferences", token, { dialect: "es-AR", uiDialect: "es-AR" });
    expect(put.status).toBe(200);
    expect(await (await send("GET", "/api/me/preferences", token)).json()).toEqual({ dialect: "es-AR", uiDialect: "es-AR" });
    const bad = await send("PUT", "/api/me/preferences", token, { dialect: "nope", uiDialect: null });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("replaces the glossary, and takes a full list of maximum length entries", async () => {
    const { body } = await signup("ana@example.test");
    const token = body.accessToken;
    // The largest valid glossary, well past the 4kb the auth routes allow.
    const entries = Array.from({ length: LIMITS.glossaryEntries }, (_, i) => ({
      source: `${i}`.padEnd(LIMITS.glossaryTerm, "ñ"),
      target: "t".repeat(LIMITS.glossaryTranslation),
      sourceDialect: "es-AR",
      targetDialect: "en-US",
    }));
    const put = await send("PUT", "/api/me/glossary", token, { entries });
    expect(put.status).toBe(200);
    const got = (await (await send("GET", "/api/me/glossary", token)).json()) as { entries: unknown[] };
    expect(got.entries).toEqual(entries);

    const tooMany = await send("PUT", "/api/me/glossary", token, { entries: [...entries, entries[0]] });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "INVALID_INPUT" });
  });

  it("keeps the 4kb bound on the auth routes", async () => {
    const response = await post("/api/auth/login", { email: "a@example.test", password: "x".repeat(5_000) });
    expect(response.status).toBe(413);
  });

  it("lists calls and contacts", async () => {
    const ana = await signup("ana@example.test");
    const ben = await signup("ben@example.test");
    const anaId = (ana.body.user as { id: string }).id;
    const benId = (ben.body.user as { id: string }).id;
    const call = account.callStarted({ userId: anaId, roomHash: "h", peerUserId: benId, now: Date.now() });
    account.callEnded(call as string, Date.now() + 1);

    const calls = (await (await send("GET", "/api/me/calls?limit=10", ana.body.accessToken)).json()) as {
      calls: Array<{ peer: { displayName: string } | null }>;
      nextCursor: string | null;
    };
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.peer?.displayName).toBe("ben");
    expect(calls.nextCursor).toBeNull();

    const contacts = (await (await send("GET", "/api/me/contacts", ana.body.accessToken)).json()) as {
      contacts: Array<{ displayName: string; callCount: number }>;
    };
    expect(contacts.contacts).toMatchObject([{ displayName: "ben", callCount: 1 }]);

    expect((await send("GET", "/api/me/calls?limit=9999", ana.body.accessToken)).status).toBe(400);
  });
});

describe("DELETE /api/account", () => {
  it("refuses the wrong password with 401 INVALID_CREDENTIALS, then deletes with the right one", async () => {
    const { body } = await signup("ana@example.test");
    const wrong = await send("DELETE", "/api/account", body.accessToken, { password: "not it at all" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "INVALID_CREDENTIALS" });

    const right = await send("DELETE", "/api/account", body.accessToken, { password: PASSWORD });
    expect(right.status).toBe(204);

    expect((await send("GET", "/api/auth/me", body.accessToken)).status).toBe(401);
    expect((await post("/api/auth/refresh", { refreshToken: body.refreshToken })).status).toBe(401);
    expect((await post("/api/auth/login", { email: "ana@example.test", password: PASSWORD })).status).toBe(401);
  });
});
