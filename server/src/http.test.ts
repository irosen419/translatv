// The HTTP surface, over a real listening server.
//
// /healthz is read by load balancers and by the iOS app, which needs to know which version of the
// wire protocol it is about to speak before it opens a socket.

import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROTOCOL_VERSION } from "@translatv/shared";
import type { Config } from "./config.js";
import { createApp } from "./http.js";

let server: Server;
let base: string;

function config(): Config {
  return {
    port: 0,
    repoRoot: tmpdir(),
    allowedOrigins: [],
    anthropicApiKey: null,
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    iceServers: [],
    adminPassword: null,
    isProduction: false,
    trustProxy: false,
  };
}

beforeEach(async () => {
  // A client dist that does not exist, so the SPA fallback is the 503 page and nothing on disk
  // is served.
  server = createServer(createApp(config(), join(tmpdir(), "translatv-no-such-dist")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /healthz", () => {
  it("reports the wire protocol version this server speaks", async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Checked as a number first: if the constant were ever missing, undefined would equal
    // undefined and this test would pass while proving nothing.
    expect(typeof body.protocolVersion).toBe("number");
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it("still reports translation as not configured when there is no key", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.translation).toBe("not_configured");
  });
});
