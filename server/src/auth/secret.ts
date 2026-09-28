// AUTH_SECRET: the key every access token is signed under.
//
// Production refuses to start without one, the same shape as the ledger and database guards in
// index.ts: a server that signed tokens under a secret nobody configured would either sign them
// under something guessable or under something random that changes on every restart, and a
// restart would sign everyone out. Neither is a deploy anybody meant.
//
// Development generates a random secret per process instead, and index.ts says it did. The value
// is never logged. The cost is that restarting a development server signs everyone out, which on
// a laptop is a feature: nothing survives that should not.

import { randomBytes } from "node:crypto";

/**
 * The shortest secret production accepts. 32 characters of hex is 128 bits, which is the floor
 * for an HMAC key; `openssl rand -hex 32` produces 64.
 */
export const MIN_SECRET_LENGTH = 32;

/** Why production must not start with this secret, or null when it may. */
export function authSecretRefusal(input: { isProduction: boolean; secret: string | null }): string | null {
  if (!input.isProduction) return null;
  if (input.secret === null || input.secret.length === 0) {
    return (
      "refusing to start: AUTH_SECRET is not set, so there is no key to sign session tokens " +
      "with. Set AUTH_SECRET in the environment, for example to the output of `openssl rand -hex 32`."
    );
  }
  if (input.secret.length < MIN_SECRET_LENGTH) {
    return (
      `refusing to start: AUTH_SECRET is too short (under ${MIN_SECRET_LENGTH} characters) to be ` +
      "a random key. Use the output of `openssl rand -hex 32`."
    );
  }
  return null;
}

export function resolveAuthSecret(configured: string | null): { secret: string; generated: boolean } {
  if (configured !== null && configured.length > 0) return { secret: configured, generated: false };
  return { secret: randomBytes(32).toString("hex"), generated: true };
}
