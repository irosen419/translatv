import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACCESS_TTL_MS, accessKey, mintAccessToken, verifyAccessToken } from "./accessTokens.js";

const SECRET = randomBytes(32).toString("hex");
const KEY = accessKey(SECRET);
const NOW = 1_800_000_000_000;

describe("access tokens", () => {
  it("round trip the subject while unexpired", () => {
    const { token, expiresAt } = mintAccessToken(KEY, "user-1", NOW);
    expect(expiresAt).toBe(NOW + ACCESS_TTL_MS);
    expect(verifyAccessToken(KEY, token, NOW + 1)).toBe("user-1");
  });

  it("last fifteen minutes", () => {
    expect(ACCESS_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("are refused once expired", () => {
    const { token } = mintAccessToken(KEY, "user-1", NOW);
    expect(verifyAccessToken(KEY, token, NOW + ACCESS_TTL_MS)).toBe(null);
    expect(verifyAccessToken(KEY, token, NOW + ACCESS_TTL_MS + 1)).toBe(null);
  });

  it("are refused when signed under a different secret", () => {
    const { token } = mintAccessToken(accessKey(randomBytes(32).toString("hex")), "user-1", NOW);
    expect(verifyAccessToken(KEY, token, NOW)).toBe(null);
  });

  it("refuse an edited payload, because the signature is checked before the payload is read", () => {
    const { token } = mintAccessToken(KEY, "user-1", NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "owner", exp: NOW + 10 ** 9 })).toString("base64url");
    expect(verifyAccessToken(KEY, `${forged}.${signature}`, NOW)).toBe(null);
  });

  it("answer null rather than throwing for every malformed shape", () => {
    for (const junk of ["", ".", "a.", ".b", "a.b.c", "not a token", "x".repeat(5000)]) {
      expect(verifyAccessToken(KEY, junk, NOW)).toBe(null);
    }
  });

  it("refuse a well signed payload that is missing its subject or expiry", () => {
    // Signed with the real key, so only the payload check can stop these.
    const sign = (body: object) => {
      const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
      return `${payload}.${createHmac("sha256", KEY).update(payload).digest("base64url")}`;
    };
    expect(verifyAccessToken(KEY, sign({ sub: "user-1", exp: NOW + 1000 }), NOW)).toBe("user-1");
    expect(verifyAccessToken(KEY, sign({ exp: NOW + 1000 }), NOW)).toBe(null);
    expect(verifyAccessToken(KEY, sign({ sub: "", exp: NOW + 1000 }), NOW)).toBe(null);
    expect(verifyAccessToken(KEY, sign({ sub: "user-1" }), NOW)).toBe(null);
    expect(verifyAccessToken(KEY, sign({ sub: "user-1", exp: "later" }), NOW)).toBe(null);
  });
});
