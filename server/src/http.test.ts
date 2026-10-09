// The HTTP surface, over a real listening server.
//
// /healthz is read by load balancers and by the iOS app, which needs to know which version of the
// wire protocol it is about to speak before it opens a socket.

import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { API_VERSION, PROTOCOL_VERSION } from "@translatv/shared";
import type { Config } from "./config.js";
import { expectContract } from "./contract.testkit.js";
import { createApp, type TranslationStatus } from "./http.js";

let server: Server;
let base: string;

function config(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    repoRoot: tmpdir(),
    allowedOrigins: [],
    anthropicApiKey: null,
    dailyCapUsd: 10,
    roomCapUsd: 1.5,
    iceServers: [],
    authSecret: null,
    signupMode: "invite",
    ownerEmail: null,
    isProduction: false,
    trustProxy: false,
    dataDir: tmpdir(),
    databasePath: ":memory:",
    ...overrides,
  };
}

async function listen(app: Parameters<typeof createServer>[1]): Promise<void> {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

beforeEach(async () => {
  // A client dist that does not exist, so the SPA fallback is the 503 page and nothing on disk
  // is served.
  await listen(createApp(config(), join(tmpdir(), "translatv-no-such-dist")));
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

  it("reports the account API version this server speaks", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    // As above: a number first, so a missing constant cannot pass as undefined equal to undefined.
    expect(typeof body.apiVersion).toBe("number");
    expect(body.apiVersion).toBe(API_VERSION);
  });

  it("answers the shape the exported contract describes", async () => {
    const response = await fetch(`${base}/healthz`);
    expect((await expectContract("GET", `${base}/healthz`, response))?.id).toBe("healthz");
  });

  it("answers the exported shape when translation broke at runtime, reason included", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const broken: TranslationStatus = { enabled: false, disabled: "the provider rejected the key" };
    await listen(createApp(config({ anthropicApiKey: "not-a-real-key" }), join(tmpdir(), "translatv-no-such-dist"), broken));
    const response = await fetch(`${base}/healthz`);
    const body = (await response.clone().json()) as Record<string, unknown>;
    expect(body.translation).toBe("failed");
    expect(body.reason).toBe("the provider rejected the key");
    expect((await expectContract("GET", `${base}/healthz`, response))?.id).toBe("healthz");
  });

  it("says whether signup needs an invite, and nothing about any account", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(body.signup).toBe("invite");
    // The retired admin gate is not reported any more: every server now requires signing in.
    expect("adminRequired" in body).toBe(false);
  });

  it("still reports translation as not configured when there is no key", async () => {
    const body = (await (await fetch(`${base}/healthz`)).json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.translation).toBe("not_configured");
  });
});
