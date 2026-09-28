// Accounts: who may sign up, who is signed in, and what a session is.
//
// Every rule lives here and the HTTP layer (routes.ts) only turns results into status codes, so
// the rules can be tested against an in memory database without a server in the way.
//
// Results, not exceptions, for every refusal a caller can cause. A refusal is an expected answer
// on a public endpoint, and a thrown error there tends to become a 500 with a stack trace in it.
//
// Sessions are two tokens:
//   access   15 minutes, signed, stored nowhere (accessTokens.ts). Sent on every request and on
//            the WebSocket upgrade.
//   refresh  30 days, opaque random, stored ONLY as a sha256, and ROTATED on every use: each
//            refresh spends the presented token and issues a new one in the same family.
//            Presenting a token that was already spent is the signature of theft (the thief and
//            the real client both hold it, and whichever uses it second is the tell), so it
//            revokes the entire family rather than just refusing.

import { createHash, createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
import {
  deleteAccountRequest,
  loginRequest,
  refreshRequest,
  signupRequest,
  type AuthErrorCode,
  type AuthSession,
  type PublicUser,
  type SignupMode,
} from "@translatv/shared";

import { log } from "../log.js";
import { consumeInvite, insertInvite, inviteIsUsable } from "../store/invites.js";
import { clearLockout, findLockout, pruneLockouts, saveLockout } from "../store/loginLockouts.js";
import {
  findRefreshTokenByHash,
  insertRefreshToken,
  markRefreshTokenUsed,
  pruneRefreshTokens,
  revokeRefreshFamily,
} from "../store/refreshTokens.js";
import type { Store } from "../store/store.js";
import {
  deleteUser,
  findUserByEmail,
  findUserById,
  insertUser,
  newUserId,
  syncOwner,
  type UserRow,
} from "../store/users.js";
import { accessKey, mintAccessToken, verifyAccessToken } from "./accessTokens.js";
import { dummyHash, hashPassword, passwordIsAcceptable, verifyPassword } from "./passwords.js";

/** How long a refresh token lasts. Each rotation issues a new one with a fresh 30 days. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an invite can wait to be used. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Consecutive failed logins before an account locks, and for how long.
 *
 * Ten is far past any honest typo streak and far short of a useful guessing run; the per IP
 * limits in routes.ts bound how fast those ten can come. The lock is also a lever a stranger can
 * pull on somebody else's account, which is why it is fifteen minutes and not a day: long enough
 * to make guessing pointless, short enough that being locked out by someone else is a nuisance
 * rather than an outage.
 */
export const MAX_FAILURES = 10;
export const LOCK_MS = 15 * 60 * 1000;

/** Failures older than this stop counting, so ten typos spread over a month do not lock anyone. */
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** Invite codes: Crockford base32, the same alphabet as room codes, in three groups of four. */
const INVITE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const INVITE_GROUPS = 3;
const INVITE_GROUP_LENGTH = 4;

export interface AuthOptions {
  secret: string;
  signupMode: SignupMode;
  /** Already normalized (trimmed, lowercased), or null for no owner. */
  ownerEmail: string | null;
}

export type AuthResult<T> = { ok: true; value: T } | { ok: false; error: AuthErrorCode };

function refuse<T>(error: AuthErrorCode): AuthResult<T> {
  return { ok: false, error };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Fold what a person might type into the canonical code: case, spaces, dashes, lookalikes. */
export function normalizeInvite(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

/**
 * Mint one single use invite straight into the store, and return the code (only its hash is kept).
 *
 * AuthService.createInvite is this. The CLI calls it directly rather than through an AuthService,
 * because constructing one also makes the owner flag agree with ITS OWNER_EMAIL: run from a shell
 * where OWNER_EMAIL was not set, the CLI demoted the live owner.
 */
export function mintInvite(store: Store, createdBy: string | null, now: number): { code: string; expiresAt: number } {
  const code = generateInvite();
  const expiresAt = now + INVITE_TTL_MS;
  insertInvite(store, {
    codeHash: sha256(normalizeInvite(code)),
    createdBy,
    createdAt: now,
    expiresAt,
  });
  return { code, expiresAt };
}

function generateInvite(): string {
  const groups: string[] = [];
  for (let g = 0; g < INVITE_GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < INVITE_GROUP_LENGTH; i += 1) {
      group += INVITE_ALPHABET[randomInt(0, INVITE_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join("-");
}

function toPublic(user: UserRow): PublicUser {
  return { id: user.id, displayName: user.displayName, isOwner: user.isOwner };
}

export class AuthService {
  private readonly signingKey: Buffer;
  /** Keys the lockout table's email hashes, so the table cannot be reversed with a word list. */
  private readonly lockoutKey: Buffer;
  /** Pruning is cheap but not free; once a minute is plenty for tables this small. */
  private lastPrune = 0;
  /** Told the id of each deleted account, after the delete commits (the socket layer listens). */
  private readonly deletedListeners = new Set<(userId: string) => void>();

  constructor(
    private readonly store: Store,
    private readonly options: AuthOptions,
  ) {
    this.signingKey = accessKey(options.secret);
    this.lockoutKey = Buffer.from(hkdfSync("sha256", options.secret, "", "translatv lockout v1", 32));
    syncOwner(store, options.ownerEmail);
  }

  get signupMode(): SignupMode {
    return this.options.signupMode;
  }

  // -------------------------------------------------------------------------
  // Signup, login, refresh, logout
  // -------------------------------------------------------------------------

  async signup(body: unknown, now: number): Promise<AuthResult<AuthSession>> {
    const parsed = signupRequest.safeParse(body);
    if (!parsed.success) return refuse("INVALID_INPUT");
    const { email, password, displayName } = parsed.data;

    // Checked BEFORE the password policy and before hashing, so a caller with no invite learns
    // nothing else and costs no scrypt.
    const inviteHash = parsed.data.invite ? sha256(normalizeInvite(parsed.data.invite)) : null;
    if (this.options.signupMode === "invite") {
      if (inviteHash === null || !inviteIsUsable(this.store, inviteHash, now)) return refuse("INVITE_INVALID");
    }
    if (!passwordIsAcceptable(password)) return refuse("WEAK_PASSWORD");

    // The slow part, done OUTSIDE the transaction: a transaction must be synchronous, and holding
    // the write lock across tens of milliseconds of scrypt would serialize every sign up anyway.
    const passwordHash = await hashPassword(password);

    // Everything that decides whether the account exists happens in ONE synchronous transaction,
    // so the email and the invite are checked and spent atomically. A taken email returns before
    // anything is written, so the invite survives for the person to use with another address.
    const user: UserRow = {
      id: newUserId(),
      email,
      passwordHash,
      displayName,
      isOwner: this.options.ownerEmail !== null && email === this.options.ownerEmail,
      createdAt: now,
    };
    let outcome: AuthErrorCode | null;
    try {
      outcome = this.store.transaction((): AuthErrorCode | null => {
        if (findUserByEmail(this.store, email)) return "EMAIL_TAKEN";
        insertUser(this.store, user);
        if (this.options.signupMode === "invite") {
          if (inviteHash === null || !consumeInvite(this.store, inviteHash, user.id, now)) {
            throw new InviteLost();
          }
        }
        return null;
      });
    } catch (error) {
      if (error instanceof InviteLost) return refuse("INVITE_INVALID");
      throw error;
    }
    if (outcome !== null) return refuse(outcome);

    log.info("auth.signup", { user: user.id, mode: this.options.signupMode });
    return { ok: true, value: this.issueSession(user, randomBytes(16).toString("base64url"), now) };
  }

  async login(body: unknown, now: number): Promise<AuthResult<AuthSession>> {
    const parsed = loginRequest.safeParse(body);
    if (!parsed.success) return refuse("INVALID_INPUT");
    const { email, password } = parsed.data;
    this.pruneAt(now);

    const lockKey = this.emailKey(email);
    if (this.isLocked(lockKey, now)) {
      log.warn("auth.locked", {});
      return refuse("LOCKED");
    }

    const user = findUserByEmail(this.store, email);
    // An email with no account still pays for one full verification, so the time a refusal takes
    // says nothing about whether the account exists.
    const matches = await verifyPassword(password, user?.passwordHash ?? (await dummyHash()));

    // Read the lock again, because the verification awaited and other requests for this email ran
    // meanwhile. Checking only before it answered every guess already in flight when the tenth
    // failure landed, and each wrong one wrote a fresh count over the lock (recordFailure), so a
    // wave of concurrent guesses was never capped. A right password is refused here too: whether
    // it was right must not reach anyone once the account is locked.
    if (this.isLocked(lockKey, now)) {
      log.warn("auth.locked", {});
      return refuse("LOCKED");
    }

    if (!user || !matches) {
      this.recordFailure(lockKey, now);
      log.warn("auth.refused", {});
      return refuse("INVALID_CREDENTIALS");
    }

    clearLockout(this.store, lockKey);
    log.info("auth.login", { user: user.id });
    return { ok: true, value: this.issueSession(user, randomBytes(16).toString("base64url"), now) };
  }

  refresh(body: unknown, now: number): AuthResult<AuthSession> {
    const parsed = refreshRequest.safeParse(body);
    if (!parsed.success) return refuse("INVALID_INPUT");
    this.pruneAt(now);

    return this.store.transaction((): AuthResult<AuthSession> => {
      const row = findRefreshTokenByHash(this.store, sha256(parsed.data.refreshToken));
      if (!row || row.revokedAt !== null) return refuse("INVALID_REFRESH");

      if (row.usedAt !== null) {
        // Reuse. Somebody else has this token, or had it first. End every session descended
        // from this sign in, the thief's newest one included.
        const revoked = revokeRefreshFamily(this.store, row.familyId, now);
        log.warn("auth.refresh_reuse", { user: row.userId, revoked });
        return refuse("INVALID_REFRESH");
      }
      if (row.expiresAt <= now) return refuse("INVALID_REFRESH");

      const user = findUserById(this.store, row.userId);
      if (!user) return refuse("INVALID_REFRESH");

      markRefreshTokenUsed(this.store, row.id, now);
      return { ok: true, value: this.issueSession(user, row.familyId, now) };
    });
  }

  /** Ends the sign in the token belongs to. Silent about tokens it does not know. */
  logout(body: unknown, now: number): void {
    const parsed = refreshRequest.safeParse(body);
    if (!parsed.success) return;
    const row = findRefreshTokenByHash(this.store, sha256(parsed.data.refreshToken));
    if (!row) return;
    revokeRefreshFamily(this.store, row.familyId, now);
    log.info("auth.logout", { user: row.userId });
  }

  // -------------------------------------------------------------------------
  // Reading a session
  // -------------------------------------------------------------------------

  /**
   * The user id an access token speaks for, or null.
   *
   * Also checks the account still exists. The signature alone would keep a deleted account's
   * token working for up to fifteen minutes; one primary key lookup closes that, and this runs
   * per request and per upgrade, not per message.
   */
  verifyAccess(token: string, now: number): string | null {
    const userId = verifyAccessToken(this.signingKey, token, now);
    if (userId === null) return null;
    return findUserById(this.store, userId) ? userId : null;
  }

  userFor(userId: string): PublicUser | null {
    const user = findUserById(this.store, userId);
    return user ? toPublic(user) : null;
  }

  // -------------------------------------------------------------------------
  // Deleting an account
  // -------------------------------------------------------------------------

  /**
   * Delete the signed in account, after proving the password again.
   *
   * Re authentication, because the access token only proves this device was signed in within
   * fifteen minutes, and this cannot be undone. A wrong password counts toward the same lockout
   * a login does: otherwise a stolen access token would buy an unlimited password oracle.
   *
   * One transaction deletes the user row, and ON DELETE does the rest (migrations.ts): refresh
   * tokens, preferences, glossary and the user's own call history cascade, which is what revokes
   * every session, and the rows that only MENTION the user (invites, other people's call history)
   * keep standing with the mention nulled. Access tokens already issued die on their next use,
   * because verifyAccess looks the account up. The spend ledger is a file this never opens.
   *
   * Listeners run after the commit, so the socket layer disconnects a user who is really gone.
   */
  async deleteAccount(userId: string, body: unknown, now: number): Promise<AuthResult<null>> {
    const parsed = deleteAccountRequest.safeParse(body);
    if (!parsed.success) return refuse("INVALID_INPUT");
    const user = findUserById(this.store, userId);
    if (!user) return refuse("UNAUTHENTICATED");

    const lockKey = this.emailKey(user.email);
    if (this.isLocked(lockKey, now)) {
      log.warn("auth.locked", {});
      return refuse("LOCKED");
    }
    const matches = await verifyPassword(parsed.data.password, user.passwordHash);
    // Again after the await, for the reason login gives.
    if (this.isLocked(lockKey, now)) {
      log.warn("auth.locked", {});
      return refuse("LOCKED");
    }
    if (!matches) {
      this.recordFailure(lockKey, now);
      log.warn("account.delete_refused", { user: userId });
      return refuse("INVALID_CREDENTIALS");
    }

    const removed = this.store.transaction(() => {
      const gone = deleteUser(this.store, userId);
      clearLockout(this.store, lockKey);
      return gone;
    });
    // Deleted by another request during the password check. Same answer as a token for nobody.
    if (!removed) return refuse("UNAUTHENTICATED");

    log.info("account.deleted", { user: userId });
    for (const listener of this.deletedListeners) {
      try {
        listener(userId);
      } catch (error) {
        log.error("account.deleted_listener_failed", { error: error instanceof Error ? error.message : "unknown" });
      }
    }
    return { ok: true, value: null };
  }

  /** Hear about every deleted account. Returns the unsubscribe. */
  onAccountDeleted(listener: (userId: string) => void): () => void {
    this.deletedListeners.add(listener);
    return () => this.deletedListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  /**
   * Mint a single use invite. `createdBy` is null from the command line.
   *
   * Returns the code exactly once. Only its hash is stored, so a lost code is replaced with a new
   * one rather than looked up.
   */
  createInvite(createdBy: string | null, now: number): { code: string; expiresAt: number } {
    return mintInvite(this.store, createdBy, now);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private issueSession(user: UserRow, familyId: string, now: number): AuthSession {
    const refreshToken = randomBytes(32).toString("base64url");
    insertRefreshToken(this.store, {
      id: randomBytes(16).toString("base64url"),
      userId: user.id,
      familyId,
      tokenHash: sha256(refreshToken),
      createdAt: now,
      expiresAt: now + REFRESH_TTL_MS,
      usedAt: null,
      revokedAt: null,
    });
    const access = mintAccessToken(this.signingKey, user.id, now);
    return {
      accessToken: access.token,
      accessExpiresAt: access.expiresAt,
      refreshToken,
      user: toPublic(user),
    };
  }

  private emailKey(email: string): string {
    return createHmac("sha256", this.lockoutKey).update(email).digest("hex");
  }

  /** Is the email behind this key locked at `now`? */
  private isLocked(lockKey: string, now: number): boolean {
    const lockedUntil = findLockout(this.store, lockKey)?.lockedUntil ?? null;
    return lockedUntil !== null && lockedUntil > now;
  }

  /**
   * Count one failure, locking at MAX_FAILURES.
   *
   * It writes a fresh count with no lock below the limit, so a caller must have seen isLocked
   * say false with no await in between: recorded over a live lock, a failure would erase it.
   */
  private recordFailure(lockKey: string, now: number): void {
    const previous = findLockout(this.store, lockKey);
    const recent = previous !== null && now - previous.lastFailureAt < FAILURE_WINDOW_MS;
    const failures = (recent ? previous.failures : 0) + 1;
    if (failures >= MAX_FAILURES) {
      // The count starts again after the lock, so a lock is fifteen minutes per ten failures
      // rather than a lock that re arms on every single failure that follows it.
      saveLockout(this.store, lockKey, { failures: 0, lastFailureAt: now, lockedUntil: now + LOCK_MS });
      log.warn("auth.lockout", { minutes: LOCK_MS / 60_000 });
      return;
    }
    saveLockout(this.store, lockKey, { failures, lastFailureAt: now, lockedUntil: null });
  }

  private pruneAt(now: number): void {
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    pruneLockouts(this.store, now, FAILURE_WINDOW_MS);
    pruneRefreshTokens(this.store, now, REFRESH_TTL_MS);
  }

}

/**
 * Thrown inside the signup transaction so the inserted user is rolled back with it. Only reachable
 * if the invite was spent between the check and the write, which the single threaded store makes a
 * formality, but a formality that fails closed.
 */
class InviteLost extends Error {}
