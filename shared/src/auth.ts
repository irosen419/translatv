// The HTTP account API under /api: request schemas, the session shape, and the error codes.
//
// Here rather than in protocol.ts because it is not the WebSocket wire format, and here rather
// than in the server because the web client and (later) the iOS app speak it too. Same rule as
// the wire protocol: the zod schema is the server's validation AND the source of the types, so
// the two sides cannot drift.
//
// Every error is a CODE, never prose, for the same reason the WebSocket's are: the sentence a
// person reads is chosen by the client in the reader's own language.

import { z } from "zod";
import { username } from "./protocol.js";

/**
 * The password policy (owner decision, 2026-11-12): at least 8 characters, with a lowercase
 * letter, an uppercase letter, a number and a symbol. Enforced by server/src/auth/passwords.ts at
 * signup; the client runs the same function to tick each rule off as the person types. Sign in
 * never checks it, so an account made under an older rule still signs in.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

/** Each rule, in the order the signup form lists them. */
export const PASSWORD_RULES = ["length", "lowercase", "uppercase", "digit", "symbol"] as const;
export type PasswordRule = (typeof PASSWORD_RULES)[number];

// Unicode classes rather than A to Z, so Ñ and á count as letters for a Spanish speaker. A symbol
// is anything that is not a letter, a number or whitespace: a space alone is not a symbol.
const RULE_TESTS: Record<Exclude<PasswordRule, "length">, RegExp> = {
  lowercase: /\p{Ll}/u,
  uppercase: /\p{Lu}/u,
  digit: /\p{Nd}/u,
  symbol: /[^\p{L}\p{N}\s]/u,
};

/** The rules this password does not meet, in PASSWORD_RULES order. Empty means acceptable. */
export function unmetPasswordRules(password: string): PasswordRule[] {
  return PASSWORD_RULES.filter((rule) =>
    rule === "length"
      ? password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH
      : !RULE_TESTS[rule].test(password),
  );
}

/**
 * Invite codes: Crockford base32 (no I, L, O or U), the same alphabet as room codes, in three
 * dashed groups of four, such as 2CPW-GDFB-QTVT. The server mints them (server/src/auth/service.ts)
 * and the signup form masks its input to this shape.
 */
export const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const INVITE_GROUPS = 3;
export const INVITE_GROUP_LENGTH = 4;
export const INVITE_CODE_LENGTH = INVITE_GROUPS * INVITE_GROUP_LENGTH;

/**
 * Fold what a person typed into code characters only: uppercase, each lookalike read as the
 * character the alphabet really has (O as 0, I and L as 1, U as V), and everything else dropped.
 */
function inviteCharacters(input: string): string {
  return [...input.toUpperCase()]
    .map((c) => (c === "O" ? "0" : c === "I" || c === "L" ? "1" : c === "U" ? "V" : c))
    .filter((c) => INVITE_ALPHABET.includes(c))
    .join("");
}

/**
 * The invite field's mask: the typed text as the code's own shape, dashes added between groups
 * and nothing past the code's length. A trailing dash the person typed is kept, so typing the
 * dash themselves does not fight the mask.
 */
export function formatInviteInput(input: string): string {
  const chars = inviteCharacters(input).slice(0, INVITE_CODE_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += INVITE_GROUP_LENGTH) groups.push(chars.slice(i, i + INVITE_GROUP_LENGTH));
  const formatted = groups.join("-");
  const full = chars.length % INVITE_GROUP_LENGTH === 0 && chars.length > 0 && chars.length < INVITE_CODE_LENGTH;
  return full && /-\s*$/.test(input) ? `${formatted}-` : formatted;
}

/**
 * The canonical code (twelve characters, no dashes) for a complete code, or null for anything
 * else. The server's sanitizer: only text that could be a real code reaches the store.
 */
export function canonicalInvite(input: string): string | null {
  const stripped = input.toUpperCase().replace(/[\s-]/g, "");
  if (stripped.length !== INVITE_CODE_LENGTH) return null;
  const chars = inviteCharacters(stripped);
  return chars.length === INVITE_CODE_LENGTH ? chars : null;
}
export const MAX_EMAIL_LENGTH = 254;

/**
 * An email address, normalized: trimmed and lowercased, so "Ana@Example.com" and
 * "ana@example.com " are one account rather than two. Deliberately loose about the local part,
 * because the only real test of an address is mail arriving at it, and this app sends none.
 */
export const email = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  // A pipe rather than a refine, so the exported schema carries the length and the pattern.
  .pipe(
    z
      .string()
      .max(MAX_EMAIL_LENGTH, { message: "not an email address" })
      .regex(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, { message: "not an email address" }),
  )
  .describe("Trimmed and lowercased before it is checked, so send it already normalized.");

/** Length only. The policy check (and its specific error code) happens on the server. */
const password = z.string().max(MAX_PASSWORD_LENGTH);

/** An invite code as a person types it. Normalized server side, so dashes and case are forgiven. */
const inviteCode = z.string().max(64);

export const signupRequest = z.object({
  invite: inviteCode.optional(),
  email,
  password,
  /** The name shown in the app. The same rules as a per chat username, for the same reasons. */
  displayName: username,
});
export type SignupRequest = z.input<typeof signupRequest>;

export const loginRequest = z.object({ email, password });
export type LoginRequest = z.input<typeof loginRequest>;

export const refreshRequest = z.object({ refreshToken: z.string().min(1).max(256) });
export type RefreshRequest = z.input<typeof refreshRequest>;

/** POST /api/auth/logout takes the same body as refresh: the token to revoke. */
export const logoutRequest = refreshRequest;
export type LogoutRequest = RefreshRequest;

export const publicUser = z.object({
  id: z.string(),
  displayName: z.string(),
  isOwner: z.boolean(),
});
export type PublicUser = z.infer<typeof publicUser>;

/** What signup, login and refresh all answer with. */
export const authSession = z.object({
  accessToken: z.string(),
  /** Epoch milliseconds. The client refreshes a little before this rather than on a 401 alone. */
  accessExpiresAt: z.number(),
  refreshToken: z.string(),
  user: publicUser,
});
export type AuthSession = z.infer<typeof authSession>;

/** GET /api/auth/me. Wrapped, so the answer can grow a field beside the user without a version. */
export const meResponse = z.object({ user: publicUser });
export type MeResponse = z.infer<typeof meResponse>;

export const inviteResponse = z.object({ code: z.string(), expiresAt: z.number() });
export type InviteResponse = z.infer<typeof inviteResponse>;

export const authErrorCode = z.enum([
  /** The body did not parse: missing field, not an email, a name with nothing left after cleaning. */
  "INVALID_INPUT",
  /** The password misses a rule of the policy (unmetPasswordRules says which). */
  "WEAK_PASSWORD",
  /** Invite only signup, and the code is missing, unknown, expired or already used. */
  "INVITE_INVALID",
  /** An account already has this email. Reachable only with a valid invite in invite mode. */
  "EMAIL_TAKEN",
  /**
   * Wrong email or wrong password, deliberately not saying which, so a login attempt cannot be
   * used to learn whether an address has an account.
   */
  "INVALID_CREDENTIALS",
  /** Too many failed logins for this account; wait and try again. Reached identically whether or
   *  not the account exists. */
  "LOCKED",
  /** The refresh token is unknown, expired, revoked, or was already used. Sign in again. */
  "INVALID_REFRESH",
  /** No valid access token. */
  "UNAUTHENTICATED",
  /** Signed in, but this is for the owner only. */
  "FORBIDDEN",
  /**
   * DELETE /api/account named a different account than the one this access token is for. The
   * tab is showing an account it is no longer signed in as (another tab signed in to another
   * one). Nothing was deleted, and the password was not checked.
   */
  "ACCOUNT_MISMATCH",
  "RATE_LIMITED",
  /**
   * The contactId names nobody this account has been on a call with (to block or report), or
   * nobody it has blocked (to unblock). The same answer for an id that was never anyone's, so it
   * says nothing about which accounts exist.
   */
  "CONTACT_NOT_FOUND",
  /** The owner asked to review a report id that does not exist. */
  "REPORT_NOT_FOUND",
]);
export const AUTH_ERROR_CODES = authErrorCode.options;
export type AuthErrorCode = z.infer<typeof authErrorCode>;

/**
 * Every code an error body under /api can carry: the account API's own, plus the two the router
 * answers itself. NOT_FOUND is an unknown path under /api (rather than the web app's index.html
 * with a 200), and INTERNAL is an unexpected failure. Kept out of authErrorCode because no
 * service ever returns them, and the router's status table is keyed by that type.
 */
export const apiErrorCode = z.enum([...AUTH_ERROR_CODES, "NOT_FOUND", "INTERNAL"]);
export const API_ERROR_CODES = apiErrorCode.options;
export type ApiErrorCode = z.infer<typeof apiErrorCode>;

/** The body of every refusal under /api. The code and nothing else: the client picks the words. */
export const apiError = z.object({ error: apiErrorCode });
export type ApiError = z.infer<typeof apiError>;

export const signupMode = z.enum(["invite", "open"]);
export type SignupMode = z.infer<typeof signupMode>;
