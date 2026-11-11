// Spend attribution: which environment a paid call ran in, and whose call it was.
//
// Every ledger row already says WHAT was spent (program, model, tokens, cost) and in which room
// (a hash of the room code). It did not say WHERE (a laptop, the Pi, a hosted server) or WHO, so
// the only way to tell testing from production was which copy of the ledger a row sat in, and
// there was no way at all to tell the owner's own calls from everyone else's. These are the two
// labels that answer that, written onto each runtime row by TranslationService.
//
// The ledger is committed to a PUBLIC repository, so the "who" is never an account id, an email
// or a name. It is a keyed hash: stable for one person on one server, so their spend can be
// grouped, and not recomputable from an account id by anyone without the server's key.

import { createHmac } from "node:crypto";

/**
 * An environment name: lowercase letters, digits and inner hyphens, at most 32 characters.
 * Narrow on purpose. It becomes a column the dashboard groups by, so "Pi", "pi " and "the pi"
 * must not become three environments.
 */
export const SPEND_ENV_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** What a user tag looks like on a ledger row. */
export const USER_TAG_PATTERN = /^[0-9a-f]{16}$/;

/**
 * The environment this process spends in (SPEND_ENV).
 *
 * Unset means "local" outside production and "production" in it, so a developer's laptop labels
 * its own testing without anyone remembering to set anything, which is the case that matters:
 * testing spend that forgot to say so would be counted as real use. A server that is not the
 * main production one (the Pi, a staging host) names itself, for example SPEND_ENV=pi.
 *
 * Refused rather than cleaned up when it does not fit, like SIGNUP_MODE and SERVE_CLIENT: a
 * silently rewritten name would split one environment's spend across two labels.
 */
export function resolveSpendEnv(raw: string | undefined, isProduction: boolean): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return isProduction ? "production" : "local";
  if (!SPEND_ENV_PATTERN.test(value)) {
    throw new Error(
      `SPEND_ENV must be lowercase letters, digits and hyphens (at most 32, not starting or ending ` +
        `with a hyphen), for example "local", "pi" or "production". Got ${JSON.stringify(raw)}.`,
    );
  }
  return value;
}

/**
 * The key user tags are made with, derived from the sign in key (AUTH_SECRET) under its own label.
 *
 * Derived rather than the sign in key itself, so a tag is never an HMAC under the key that signs
 * access tokens. Tied to AUTH_SECRET so it needs no second secret to configure, which also means
 * tags change if AUTH_SECRET is rotated. In development an unset AUTH_SECRET is random per
 * process, so local tags change on every restart; that only affects grouping local test calls.
 */
export function spendTagKey(authSecret: string): Buffer {
  return createHmac("sha256", authSecret).update("translatv spend user tag v1").digest();
}

/** One person's tag: the first 16 hex characters of an HMAC of their account id. */
export function userTag(key: Buffer, userId: string): string {
  return createHmac("sha256", key).update(userId).digest("hex").slice(0, 16);
}

/** What TranslationService needs to label the rows it writes. */
export interface SpendAttribution {
  /** This process's environment, from resolveSpendEnv. */
  env: string;
  /** The key user tags are made with, or null to write no tags. */
  tagKey: Buffer | null;
}
