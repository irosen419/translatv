// /api/auth and /api/invites over real HTTP: status codes, error codes, body limits, and the per
// IP limits. The rules themselves are proved in service.test.ts; this proves the mapping.

import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../config.js";
import { createApp } from "../http.js";
import { openStore, type Store } from "../store/index.js";
import { AuthService } from "./service.js";

const PASSWORD = randomBytes(12).toString("hex");

let server: Server;
let base: string;
let store: Store;
let auth: AuthService;

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
  server = createServer(createApp(config(), join(tmpdir(), "translatv-no-such-dist"), undefined, auth));
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
