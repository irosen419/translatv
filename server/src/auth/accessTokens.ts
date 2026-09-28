// Access tokens: short lived, signed statements of who the bearer is.
//
// The same construction the retired admin token used, `<payload>.<signature>` with the payload a
// base64url JSON object and the signature an HMAC SHA256 over the payload's exact bytes. What
// changed is where the key comes from (AUTH_SECRET, not a password) and what the payload says
// (a user id, not "you are the admin").
//
// Deliberately NOT stored anywhere. Fifteen minutes is short enough that a stolen one expires
// before most people would notice, and the refresh token, which IS stored and can be revoked, is
// what decides whether a new one is issued. Revoking a session therefore takes effect within one
// access lifetime rather than instantly, which is the standard trade for not touching the
// database on every WebSocket upgrade.
//
// Nothing here throws on bad input: verification sits on unauthenticated paths, and a crash on a
// malformed header would be a denial of service handed to anyone who can reach the port.

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** How long an access token is good for. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;

/**
 * Longest token worth verifying. A real one is well under 200 characters; this stops a huge
 * header from being hashed at all.
 */
const MAX_TOKEN_LENGTH = 512;

/**
 * The signing key, derived from AUTH_SECRET.
 *
 * HKDF with a context string rather than the secret used raw, so the same AUTH_SECRET can later
 * key something else (a different token type) without the two ever being able to validate each
 * other's signatures. AUTH_SECRET is already high entropy random bytes, which is what HKDF is for;
 * scrypt, which the admin token needed because its input was a human password, would add nothing.
 */
export function accessKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", secret, "", "translatv access token v1", 32));
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function mintAccessToken(
  key: Buffer,
  userId: string,
  now: number,
): { token: string; expiresAt: number } {
  const expiresAt = now + ACCESS_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: expiresAt }), "utf8").toString("base64url");
  return { token: `${payload}.${sign(payload, key)}`, expiresAt };
}

/**
 * The user id this token speaks for, or null.
 *
 * The signature is checked BEFORE the payload is parsed, so an edited payload is refused by the
 * signature rather than believed.
 */
export function verifyAccessToken(key: Buffer, token: string, now: number): string | null {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (signature.includes(".")) return null;

  const expected = Buffer.from(sign(payload, key), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sub, exp } = parsed as { sub?: unknown; exp?: unknown };
    if (typeof sub !== "string" || sub.length === 0) return null;
    if (typeof exp !== "number" || !Number.isFinite(exp) || now >= exp) return null;
    return sub;
  } catch {
    return null;
  }
}
