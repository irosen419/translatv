// The admin credential, and the token that proves you presented it.
//
// One admin, one password, no database. That is the whole model, and it is enough because the
// thing being protected is "can this person start or join a call", not a user account system.
//
// The token is a signed statement rather than a row in a session table, because this server
// keeps room state in memory and has nowhere to put a session. Signing it with a key DERIVED
// from the password means changing the password invalidates every token already issued, which
// is the property you actually want the moment you suspect one has leaked.
//
// Nothing here ever throws on bad input. Both functions sit on unauthenticated paths, so a
// crash on a malformed value would be a denial of service handed to anyone who can reach the
// port.

import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

/** How long a login lasts before it has to be done again. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Domain separation, so this key can never collide with another use of the same password. */
const KEY_CONTEXT = "translatv admin token v1";

/**
 * Derived keys, by password.
 *
 * scrypt is deliberately slow, which is the point of using it and the reason the result is
 * cached. A single HMAC was the first version: fine for signing, weak as a KDF, because anyone
 * holding a leaked token could guess passwords offline at HMAC speed until one reproduced the
 * signature. scrypt makes each of those guesses cost real time and memory.
 *
 * Keyed by the password string, which is already held in config for the life of the process,
 * so this stores nothing that was not already in memory. At most two entries ever: the
 * configured password, and whatever a test passes in.
 *
 * KEY_CONTEXT doubles as the salt, which means it is the SAME salt in every deployment of this
 * app. A per install random salt would have to be stored somewhere, and the only store here is
 * the environment, where it would be one more thing to lose and to keep in step with the
 * password. The cost of the fixed salt is that a precomputed table could be amortised across
 * every install rather than paid for per guess, so the defense is a password long enough that
 * no table covers it. Worth knowing before anyone picks a short one.
 */
const keyCache = new Map<string, Buffer>();

function signingKey(password: string): Buffer {
  const cached = keyCache.get(password);
  if (cached) return cached;
  // Node's defaults, with the memory ceiling raised to match: N=16384 needs about 16MB and the
  // default maxmem of 32MB is enough, but stating it keeps a future N change from failing at
  // runtime instead of here.
  const key = scryptSync(password, KEY_CONTEXT, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  keyCache.set(password, key);
  return key;
}

function sign(payload: string, password: string): string {
  return createHmac("sha256", signingKey(password)).update(payload).digest("base64url");
}

/**
 * Is this the admin password?
 *
 * Compared as sha256 digests, not as strings. Digests are a fixed length, so timingSafeEqual
 * cannot throw on a mismatch, and the time taken cannot vary with how much of the password the
 * caller guessed right or how long the real one is.
 *
 * An empty configured password is never a match. A server started without ADMIN_PASSWORD must
 * refuse everyone rather than admit anyone who sends an empty string.
 */
export function passwordMatches(candidate: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Issue a token for someone who has just proved they know the password. */
export function mintAdminToken(password: string, now: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: now + TOKEN_TTL_MS }), "utf8").toString(
    "base64url",
  );
  return `${payload}.${sign(payload, password)}`;
}

/**
 * Does this token prove the bearer knew the password, and is it still valid?
 *
 * The signature is checked BEFORE the payload is trusted for anything, so an edited expiry is
 * rejected by the signature rather than believed. Returns false for every malformed shape a
 * browser can hand back: a cleared key, a truncated value, something that is not ours at all.
 */
export function verifyAdminToken(token: string, password: string, now: number): boolean {
  if (password.length === 0) return false;

  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (signature.includes(".")) return false;

  const expected = Buffer.from(sign(payload, password), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  if (!timingSafeEqual(expected, actual)) return false;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return false;
    const { exp } = parsed as { exp?: unknown };
    return typeof exp === "number" && Number.isFinite(exp) && now < exp;
  } catch {
    return false;
  }
}
