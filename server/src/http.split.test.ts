// The server as the API half of a split deployment: the web client on a static host of its own
// origin, this server answering only /api, /healthz and the socket (DEPLOY.md, "Two services").
//
// Through the real createApp with the real auth router, because the claims here are about how the
// pieces sit together: CORS in front of the limiters, not instead of them, and SERVE_CLIENT
// deciding what an unknown path gets.

import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AccountService } from "./account/service.js";
import { AUTH_LIMITS } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import type { Config } from "./config.js";
import { createApp } from "./http.js";
import { openStore, type Store } from "./store/index.js";

const STATIC = "https://app.example.com";
const PASSWORD = randomBytes(12).toString("hex");
const NO_DIST = join(tmpdir(), "translatv-no-such-dist");

let server: Server | null = null;
let store: Store | null = null;
let scratch: string | null = null;
let base = "";

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    repoRoot: tmpdir(),
    allowedOrigins: [STATIC],
    anthropicApiKey: null,
    authSecret: null,
    signupMode: "open",
    ownerEmail: null,
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    iceServers: [],
    isProduction: true,
    trustProxy: false,
    dataDir: tmpdir(),
    databasePath: ":memory:",
    serveClient: true,
    ...overrides,
  };
}

async function start(overrides: Partial<Config> = {}, clientDist = NO_DIST): Promise<void> {
  store = openStore({ path: ":memory:" });
  const cfg = config(overrides);
  const auth = new AuthService(store, { secret: randomBytes(32).toString("hex"), signupMode: cfg.signupMode, ownerEmail: null });
  server = createServer(createApp(cfg, clientDist, undefined, auth, new AccountService(store)));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  store?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  server = null;
  store = null;
  scratch = null;
});

function post(path: string, body: unknown, origin: string | null = STATIC): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

function preflight(path: string, origin = STATIC, method = "POST"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": method, "access-control-request-headers": "content-type" },
  });
}

describe("the account API, from a static site on another origin", () => {
  it("answers the preflight and the request, naming the static origin on both", async () => {
    await start();
    const pre = await preflight("/api/auth/signup");
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(STATIC);

    const response = await post("/api/auth/signup", { email: "ana@example.test", password: PASSWORD, displayName: "Ana" });
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not spend login attempts on preflights", async () => {
    await start();
    expect((await post("/api/auth/signup", { email: "ana@example.test", password: PASSWORD, displayName: "Ana" })).status).toBe(201);
    // More preflights than the whole login burst. If any of them took a token, the login after
    // them would be refused with 429.
    for (let i = 0; i < AUTH_LIMITS.login.burst * 2; i += 1) {
      expect((await preflight("/api/auth/login")).status).toBe(204);
    }
    const login = await post("/api/auth/login", { email: "ana@example.test", password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("still rate limits a cross origin login, and the 429 is readable by the page", async () => {
    await start();
    let limited: Response | null = null;
    for (let i = 0; i < 30 && !limited; i += 1) {
      const response = await post("/api/auth/login", { email: `n${i}@example.test`, password: "wrong wrong" });
      if (response.status === 429) limited = response;
    }
    expect(limited).not.toBeNull();
    expect(limited?.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(await limited?.json()).toEqual({ error: "RATE_LIMITED" });
  });

  it("still requires a bearer for a cross origin request", async () => {
    await start();
    const response = await fetch(`${base}/api/me/preferences`, { headers: { origin: STATIC } });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(await response.json()).toEqual({ error: "UNAUTHENTICATED" });
  });

  it("gives an origin that is not in ORIGIN no CORS headers, in production even on localhost", async () => {
    await start();
    for (const origin of ["https://evil.example", "http://localhost:5173"]) {
      expect((await preflight("/api/auth/login", origin)).headers.get("access-control-allow-origin")).toBeNull();
      const response = await fetch(`${base}/healthz`, { headers: { origin } });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("allows a localhost origin on another port in development, as the socket does", async () => {
    await start({ isProduction: false, allowedOrigins: [] });
    const response = await fetch(`${base}/healthz`, { headers: { origin: "http://localhost:4173" } });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4173");
  });
});

describe("/healthz, from a static site on another origin", () => {
  it("is readable by the static origin, with Vary: Origin", async () => {
    await start();
    const response = await fetch(`${base}/healthz`, { headers: { origin: STATIC } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(response.headers.get("vary") ?? "").toMatch(/\bOrigin\b/);
  });
});

describe("SERVE_CLIENT", () => {
  function builtClient(): string {
    scratch = mkdtempSync(join(tmpdir(), "translatv-dist-"));
    mkdirSync(join(scratch, "assets"));
    writeFileSync(join(scratch, "index.html"), "<!doctype html><title>the app</title>");
    writeFileSync(join(scratch, "assets", "app.js"), "console.log(1)");
    return scratch;
  }

  it("on (the default): serves the built client, and index.html for a room link", async () => {
    await start({}, builtClient());
    const room = await fetch(`${base}/r/ABCD-1234`);
    expect(room.status).toBe(200);
    expect(await room.text()).toContain("the app");
    expect((await fetch(`${base}/assets/app.js`)).status).toBe(200);
  });

  it("off: answers 404 JSON for every non API path, even with a built client on disk", async () => {
    await start({ serveClient: false }, builtClient());
    for (const path of ["/", "/r/ABCD-1234", "/assets/app.js", "/index.html"]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type") ?? "").toContain("application/json");
      expect(await response.json()).toEqual({ error: "NOT_FOUND" });
    }
  });

  it("off: still answers /healthz and the account API", async () => {
    await start({ serveClient: false });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/api/me/preferences`)).status).toBe(401);
  });
});
