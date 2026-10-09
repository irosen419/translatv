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

/** Must match server/src/auth/passwords.ts, which enforces it. The client uses it to explain. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;
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
  /** The password is shorter than MIN_PASSWORD_LENGTH. */
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
