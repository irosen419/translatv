// Where the client's requests and its socket go: one origin, set at build time.

import { WS_PATH } from "@translatv/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiUrlFor, wsUrlFor } from "./apiBase.js";

describe("apiUrlFor", () => {
  it("leaves the path relative when the API is on this origin", () => {
    expect(apiUrlFor("", "/api/auth/login")).toBe("/api/auth/login");
    expect(apiUrlFor("", "/healthz")).toBe("/healthz");
  });

  it("puts the API origin in front of the path when it is somewhere else", () => {
    expect(apiUrlFor("https://api.example.com", "/api/auth/login")).toBe("https://api.example.com/api/auth/login");
    expect(apiUrlFor("http://127.0.0.1:8080", "/healthz")).toBe("http://127.0.0.1:8080/healthz");
  });

  it("refuses a path that is not absolute, which would resolve against the page instead", () => {
    expect(() => apiUrlFor("", "api/auth/login")).toThrow();
    expect(() => apiUrlFor("https://api.example.com", "https://evil.example/api")).toThrow();
    expect(() => apiUrlFor("https://api.example.com", "//evil.example/api")).toThrow();
  });
});

describe("wsUrlFor", () => {
  it("follows the page when the API is on this origin", () => {
    expect(wsUrlFor("", { protocol: "https:", host: "call.example.com" })).toBe(`wss://call.example.com${WS_PATH}`);
    expect(wsUrlFor("", { protocol: "http:", host: "localhost:5173" })).toBe(`ws://localhost:5173${WS_PATH}`);
  });

  it("follows the API origin, not the page, when they differ", () => {
    const page = { protocol: "https:", host: "app.example.com" };
    expect(wsUrlFor("https://api.example.com", page)).toBe(`wss://api.example.com${WS_PATH}`);
    expect(wsUrlFor("http://127.0.0.1:8080", page)).toBe(`ws://127.0.0.1:8080${WS_PATH}`);
  });
});

describe("the build time setting, wired through", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("sends the session's requests to VITE_API_ORIGIN when it is set", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.example.com");
    vi.resetModules();
    const { SessionManager } = await import("../lib/session.js");
    const seen: string[] = [];
    const manager = new SessionManager({
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ error: "INVALID_CREDENTIALS" }), { status: 401 });
      },
      storage: null,
      now: () => 0,
    });
    await manager.signIn("ana@example.test", "a password");
    expect(seen).toEqual(["https://api.example.com/api/auth/login"]);
  });

  it("opens the socket on VITE_API_ORIGIN, not on the page's host", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.example.com");
    vi.resetModules();
    const { socketUrl } = await import("./socket.js");
    const original = Reflect.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      value: { protocol: "https:", host: "app.example.com" },
      configurable: true,
    });
    try {
      expect(socketUrl()).toBe(`wss://api.example.com${WS_PATH}`);
    } finally {
      if (original) Object.defineProperty(globalThis, "location", original);
      else Reflect.deleteProperty(globalThis, "location");
    }
  });

  it("fails loudly at load on a bad value, rather than falling back to relative paths", async () => {
    vi.stubEnv("VITE_API_ORIGIN", "https://api.example.com/v1");
    vi.resetModules();
    await expect(import("./apiBase.js")).rejects.toThrow(/VITE_API_ORIGIN/);
  });
});
