// CORS for the account API and /healthz, so the web client can be served from its own origin.
//
// Over a real listening server rather than with mocked req and res, because what matters is the
// headers a browser actually receives, and a preflight that never reaches a route.

import { createServer, type Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import { CORS_ALLOWED_HEADERS, CORS_ALLOWED_METHODS, CORS_MAX_AGE_SECONDS, cors } from "./cors.js";

const STATIC = "https://app.example.com";

let server: Server | null = null;

async function serve(isAllowed: (origin: string) => boolean): Promise<{ base: string; hits: () => number }> {
  let routeHits = 0;
  const app = express();
  app.use("/api", cors(isAllowed));
  app.post("/api/auth/login", (_req, res) => {
    routeHits += 1;
    res.status(401).json({ error: "INVALID_CREDENTIALS" });
  });
  app.get("/api/me/preferences", (_req, res) => {
    routeHits += 1;
    res.json({ dialect: null, uiDialect: null });
  });
  // Anything else under /api, as the real router's own 404 answers it.
  app.use("/api", (_req, res) => {
    routeHits += 1;
    res.status(404).json({ error: "NOT_FOUND" });
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { base: `http://127.0.0.1:${port}`, hits: () => routeHits };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const onlyStatic = (origin: string) => origin === STATIC;

function preflight(base: string, path: string, origin: string, method = "POST"): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": method,
      "access-control-request-headers": "authorization, content-type",
    },
  });
}

describe("cors, an actual request", () => {
  it("names an allowed origin, exactly, and never a wildcard", async () => {
    const { base } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/me/preferences`, { headers: { origin: STATIC } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
  });

  it("never allows credentials: the API is bearer only, and no cookie rides along", async () => {
    const { base } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/me/preferences`, { headers: { origin: STATIC } });
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("says the answer varies by Origin, so a shared cache cannot hand one origin's headers to another", async () => {
    const { base } = await serve(onlyStatic);
    for (const headers of [{ origin: STATIC }, { origin: "https://evil.example" }, {}]) {
      const response = await fetch(`${base}/api/me/preferences`, { headers });
      expect(response.headers.get("vary") ?? "").toMatch(/\bOrigin\b/);
    }
  });

  it("gives a disallowed origin no CORS headers at all", async () => {
    const { base } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/me/preferences`, { headers: { origin: "https://evil.example" } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(response.headers.get("access-control-allow-headers")).toBeNull();
  });

  it("does not mistake an origin that merely starts like an allowed one", async () => {
    const { base } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/me/preferences`, { headers: { origin: `${STATIC}.evil.example` } });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("adds nothing for a same origin or native request, which sends no Origin", async () => {
    const { base, hits } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/me/preferences`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(hits()).toBe(1);
  });

  it("still runs the route for a cross origin request, so its refusal is readable by the page", async () => {
    // The route answers 401 here. The header must be on the error too, or the client sees an
    // opaque network failure instead of INVALID_CREDENTIALS and says the wrong sentence.
    const { base, hits } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { origin: STATIC, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(hits()).toBe(1);
  });
});

describe("cors, a preflight", () => {
  it("answers an allowed origin's preflight itself, with the methods and headers the API uses", async () => {
    const { base } = await serve(onlyStatic);
    const response = await preflight(base, "/api/auth/login", STATIC);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(STATIC);
    expect(response.headers.get("access-control-allow-methods")).toBe(CORS_ALLOWED_METHODS.join(", "));
    expect(response.headers.get("access-control-allow-headers")).toBe(CORS_ALLOWED_HEADERS.join(", "));
    expect(response.headers.get("access-control-max-age")).toBe(String(CORS_MAX_AGE_SECONDS));
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary") ?? "").toMatch(/\bOrigin\b/);
  });

  it("allows exactly Authorization and Content-Type, and the four methods the API has", () => {
    expect([...CORS_ALLOWED_HEADERS]).toEqual(["Authorization", "Content-Type"]);
    expect([...CORS_ALLOWED_METHODS]).toEqual(["GET", "POST", "PUT", "DELETE"]);
    // Long enough to save a round trip per request, short enough that narrowing the allowlist
    // takes effect within minutes. Chromium caps it at 7200 anyway.
    expect(CORS_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(60);
    expect(CORS_MAX_AGE_SECONDS).toBeLessThanOrEqual(7200);
  });

  it("never reaches a route, so a preflight cannot spend a login attempt or a rate limit token", async () => {
    const { base, hits } = await serve(onlyStatic);
    for (let i = 0; i < 25; i += 1) await preflight(base, "/api/auth/login", STATIC);
    expect(hits()).toBe(0);
  });

  it("refuses a disallowed origin's preflight with no CORS headers, also without reaching a route", async () => {
    const { base, hits } = await serve(onlyStatic);
    const response = await preflight(base, "/api/auth/login", "https://evil.example");
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
    expect(hits()).toBe(0);
  });

  it("refuses a preflight for a method the API never uses", async () => {
    const { base } = await serve(onlyStatic);
    const response = await preflight(base, "/api/auth/login", STATIC, "PATCH");
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-methods")).toBeNull();
  });

  it("leaves an OPTIONS that is not a preflight to the routes", async () => {
    // No Access-Control-Request-Method means it is not a preflight, just an odd request.
    const { base, hits } = await serve(onlyStatic);
    const response = await fetch(`${base}/api/auth/login`, { method: "OPTIONS", headers: { origin: STATIC } });
    expect(response.status).toBe(404);
    expect(hits()).toBe(1);
  });
});
