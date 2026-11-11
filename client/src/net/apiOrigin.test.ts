// VITE_API_ORIGIN, the one build time setting that points the web client at a server on another
// origin. Checked here because a bad value must fail loudly, at build and at first load, rather
// than quietly turn into relative paths that hit the static host and 404 (or worse, hit nothing
// and look like a server outage).

import { describe, expect, it } from "vitest";

import { parseApiOrigin } from "./apiOrigin.js";

describe("parseApiOrigin", () => {
  it("reads unset, empty and blank as same origin, today's behaviour", () => {
    expect(parseApiOrigin(undefined)).toBe("");
    expect(parseApiOrigin("")).toBe("");
    expect(parseApiOrigin("   ")).toBe("");
  });

  it("takes an https or http origin, normalized", () => {
    expect(parseApiOrigin("https://api.example.com")).toBe("https://api.example.com");
    expect(parseApiOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parseApiOrigin("  HTTPS://API.Example.com  ")).toBe("https://api.example.com");
    // The default port is dropped, as the browser's own Origin header drops it.
    expect(parseApiOrigin("https://api.example.com:443")).toBe("https://api.example.com");
  });

  it("tolerates one trailing slash, which is still no path", () => {
    expect(parseApiOrigin("https://api.example.com/")).toBe("https://api.example.com");
  });

  it.each([
    ["no scheme", "api.example.com"],
    ["a relative path", "/api"],
    ["a websocket scheme", "wss://api.example.com"],
    ["another scheme", "ftp://api.example.com"],
    ["a path", "https://api.example.com/v1"],
    ["a query", "https://api.example.com?x=1"],
    ["a fragment", "https://api.example.com#top"],
    ["credentials", "https://user:pass@api.example.com"],
    ["a username alone", "https://user@api.example.com"],
    ["not a URL at all", "https://"],
  ])("refuses %s, naming the variable", (_label, value) => {
    expect(() => parseApiOrigin(value)).toThrow(/VITE_API_ORIGIN/);
  });

  it("never echoes credentials back in its refusal", () => {
    let message = "";
    try {
      parseApiOrigin("https://someone:hunter2@api.example.com");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/VITE_API_ORIGIN/);
    expect(message).not.toContain("hunter2");
  });
});
