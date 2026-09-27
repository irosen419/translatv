import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintAdminToken, passwordMatches, verifyAdminToken, TOKEN_TTL_MS } from "./adminAuth.js";

// Generated rather than written down. A literal here is indistinguishable, to a secret scanner
// and to a reader skimming, from a real credential committed by mistake, and the test does not
// care what the string is. Fresh per run also stops anything quietly depending on its value.
const PASSWORD = randomBytes(24).toString("hex");
const NOW = 1_700_000_000_000;

describe("passwordMatches", () => {
  it("accepts the password", () => {
    expect(passwordMatches(PASSWORD, PASSWORD)).toBe(true);
  });

  it("rejects a wrong password", () => {
    expect(passwordMatches("hunter2", PASSWORD)).toBe(false);
  });

  // Compared as sha256 digests rather than as raw strings. Two reasons, and the second is the
  // one that matters: digests are always the same length, so timingSafeEqual cannot throw on a
  // length mismatch, AND the comparison cannot leak the length of the real password through how
  // long it takes to fail.
  it("rejects a candidate of a different length without throwing", () => {
    expect(passwordMatches("", PASSWORD)).toBe(false);
    expect(passwordMatches("x".repeat(5000), PASSWORD)).toBe(false);
  });

  it("rejects a candidate that merely starts the same way", () => {
    expect(passwordMatches(PASSWORD.slice(0, -1), PASSWORD)).toBe(false);
  });
});

describe("admin tokens", () => {
  it("accepts a token it just minted", () => {
    const token = mintAdminToken(PASSWORD, NOW);
    expect(verifyAdminToken(token, PASSWORD, NOW)).toBe(true);
  });

  it("refuses a token signed with a different password", () => {
    // Changing the password has to invalidate every token already issued, or rotating it after a
    // leak would achieve nothing.
    const token = mintAdminToken(PASSWORD, NOW);
    expect(verifyAdminToken(token, "a new password", NOW)).toBe(false);
  });

  it("refuses a token whose payload was edited", () => {
    const token = mintAdminToken(PASSWORD, NOW);
    const [payload, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ exp: NOW + 1e12 })).toString("base64url")}.${signature}`;
    expect(forged).not.toBe(token);
    expect(payload).toBeTruthy();
    expect(verifyAdminToken(forged, PASSWORD, NOW)).toBe(false);
  });

  it("refuses a token whose signature was edited", () => {
    const token = mintAdminToken(PASSWORD, NOW);
    const [payload] = token.split(".");
    expect(verifyAdminToken(`${payload}.not-the-signature`, PASSWORD, NOW)).toBe(false);
  });

  it("refuses a token once it has expired", () => {
    const token = mintAdminToken(PASSWORD, NOW);
    expect(verifyAdminToken(token, PASSWORD, NOW + TOKEN_TTL_MS - 1)).toBe(true);
    expect(verifyAdminToken(token, PASSWORD, NOW + TOKEN_TTL_MS + 1)).toBe(false);
  });

  // Anything a browser might hand back: a cleared key, a truncated value, someone else's cookie.
  // None of these may throw, because this runs on an unauthenticated path where a crash is a
  // denial of service.
  it("refuses malformed input rather than throwing", () => {
    for (const bad of ["", ".", "..", "a.b.c", "nodot", "a.", ".b", "{}", "null"]) {
      expect(verifyAdminToken(bad, PASSWORD, NOW)).toBe(false);
    }
  });

  it("refuses everything when no password is configured", () => {
    // An empty ADMIN_PASSWORD must never mint or accept a token. Otherwise a server started
    // without the variable would hand admin rights to anyone who sent an empty string.
    expect(verifyAdminToken(mintAdminToken("", NOW), "", NOW)).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });
});
