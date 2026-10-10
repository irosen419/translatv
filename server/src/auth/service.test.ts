// The account rules, against a real in memory database.
//
// Everything that decides who gets a session lives in AuthService, and the HTTP layer only maps
// its results to status codes, so this is where the rules are proved. routes.test.ts proves the
// mapping and the limits over real HTTP.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LIMITS } from "@translatv/shared";
import { AccountService } from "../account/service.js";
import { DatabaseSync } from "../store/sqlite.js";
import { openStore, type Store } from "../store/index.js";
import { findLockout, pruneLockouts, saveLockout } from "../store/loginLockouts.js";
import { deleteUser, insertUser, newUserId } from "../store/users.js";
import { ACCESS_TTL_MS } from "./accessTokens.js";
import { hashPassword } from "./passwords.js";
import {
  AuthService,
  ERASE_ATTEMPTS,
  FAILURE_WINDOW_MS,
  LOCK_MS,
  MAX_FAILURES,
  REFRESH_TTL_MS,
  type AuthOptions,
} from "./service.js";

const NOW = 1_800_000_000_000;
// Generated, never literal. See passwords.test.ts.
const PASSWORD = randomBytes(12).toString("hex");
const SECRET = randomBytes(32).toString("hex");

let store: Store;

function service(options: Partial<AuthOptions> = {}): AuthService {
  return new AuthService(store, { secret: SECRET, signupMode: "invite", ownerEmail: null, ...options });
}

beforeEach(() => {
  store = openStore({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function count(table: string): number {
  return Number(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.["n"]);
}

async function signedUp(auth: AuthService, email = "ana@example.test") {
  const invite = auth.createInvite(null, NOW);
  const result = await auth.signup({ invite: invite.code, email, password: PASSWORD, displayName: "Ana" }, NOW);
  if (!result.ok) throw new Error(`signup failed: ${result.error}`);
  return result.value;
}

describe("signup in invite mode", () => {
  it("creates an account and a session with a valid invite", async () => {
    const auth = service();
    const session = await signedUp(auth);
    expect(session.user.displayName).toBe("Ana");
    expect(session.user.isOwner).toBe(false);
    expect(auth.verifyAccess(session.accessToken, NOW)).toBe(session.user.id);
    expect(session.accessExpiresAt).toBe(NOW + ACCESS_TTL_MS);
  });

  it("refuses with no invite, and creates nothing", async () => {
    const auth = service();
    const result = await auth.signup({ email: "ana@example.test", password: PASSWORD, displayName: "Ana" }, NOW);
    expect(result).toMatchObject({ ok: false, error: "INVITE_INVALID" });
    expect(count("users")).toBe(0);
  });

  it("refuses an invite nobody minted", async () => {
    const auth = service();
    const result = await auth.signup(
      { invite: "ABCD-EFGH-JKMN", email: "ana@example.test", password: PASSWORD, displayName: "Ana" },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: "INVITE_INVALID" });
  });

  it("spends an invite exactly once when two signups race for it", async () => {
    // Both pass the usable check before either finishes hashing its password, which awaits. The
    // conditional UPDATE in consumeInvite is what refuses the second, and nothing else would.
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    const [first, second] = await Promise.all([
      auth.signup({ invite: invite.code, email: "a@example.test", password: PASSWORD, displayName: "A" }, NOW),
      auth.signup({ invite: invite.code, email: "b@example.test", password: PASSWORD, displayName: "B" }, NOW),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(first.ok ? second : first).toMatchObject({ ok: false, error: "INVITE_INVALID" });
    expect(count("users")).toBe(1);
  });

  it("spends an invite exactly once", async () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    const first = await auth.signup({ invite: invite.code, email: "a@example.test", password: PASSWORD, displayName: "A" }, NOW);
    const second = await auth.signup({ invite: invite.code, email: "b@example.test", password: PASSWORD, displayName: "B" }, NOW);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: "INVITE_INVALID" });
  });

  it("refuses an invite after its seven days are up", async () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    expect(invite.expiresAt).toBe(NOW + 7 * 24 * 60 * 60 * 1000);
    const late = await auth.signup(
      { invite: invite.code, email: "a@example.test", password: PASSWORD, displayName: "A" },
      invite.expiresAt,
    );
    expect(late).toMatchObject({ ok: false, error: "INVITE_INVALID" });
  });

  it("forgives the case and dashes a person types an invite with", async () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    const typed = invite.code.replace(/-/g, " ").toLowerCase();
    const result = await auth.signup({ invite: typed, email: "a@example.test", password: PASSWORD, displayName: "A" }, NOW);
    expect(result.ok).toBe(true);
  });

  it("does not spend the invite when the email is already taken", async () => {
    const auth = service();
    await signedUp(auth, "ana@example.test");
    const invite = auth.createInvite(null, NOW);
    const taken = await auth.signup(
      { invite: invite.code, email: "ANA@example.test", password: PASSWORD, displayName: "Other" },
      NOW,
    );
    expect(taken).toMatchObject({ ok: false, error: "EMAIL_TAKEN" });
    const retry = await auth.signup(
      { invite: invite.code, email: "cal@example.test", password: PASSWORD, displayName: "Cal" },
      NOW,
    );
    expect(retry.ok).toBe(true);
  });

  it("refuses a password under ten characters, before spending the invite", async () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    const weak = await auth.signup({ invite: invite.code, email: "a@example.test", password: "123456789", displayName: "A" }, NOW);
    expect(weak).toMatchObject({ ok: false, error: "WEAK_PASSWORD" });
    const retry = await auth.signup({ invite: invite.code, email: "a@example.test", password: PASSWORD, displayName: "A" }, NOW);
    expect(retry.ok).toBe(true);
  });

  it("refuses a body that does not parse", async () => {
    const auth = service({ signupMode: "open" });
    for (const body of [null, "x", {}, { email: "not an email", password: PASSWORD, displayName: "A" }, { email: "a@example.test", password: PASSWORD, displayName: "​" }]) {
      expect(await auth.signup(body, NOW)).toMatchObject({ ok: false, error: "INVALID_INPUT" });
    }
  });

  it("stores the email lowercased and the password only as a hash", async () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    await auth.signup({ invite: invite.code, email: " Ana@Example.TEST ", password: PASSWORD, displayName: "Ana" }, NOW);
    const row = store.db.prepare("SELECT email, password_hash FROM users").get();
    expect(row?.["email"]).toBe("ana@example.test");
    expect(String(row?.["password_hash"])).not.toContain(PASSWORD);
  });
});

describe("signup in open mode", () => {
  it("needs no invite", async () => {
    const auth = service({ signupMode: "open" });
    const result = await auth.signup({ email: "ana@example.test", password: PASSWORD, displayName: "Ana" }, NOW);
    expect(result.ok).toBe(true);
  });
});

describe("the owner", () => {
  it("is the account whose email is OWNER_EMAIL", async () => {
    const auth = service({ ownerEmail: "owner@example.test" });
    const owner = await signedUp(auth, "Owner@Example.test");
    const other = await signedUp(auth, "ben@example.test");
    expect(owner.user.isOwner).toBe(true);
    expect(other.user.isOwner).toBe(false);
  });

  it("follows OWNER_EMAIL when it changes between boots", async () => {
    const before = await signedUp(service({ ownerEmail: null }), "owner@example.test");
    expect(before.user.isOwner).toBe(false);
    const after = service({ ownerEmail: "owner@example.test" });
    expect(after.userFor(before.user.id)?.isOwner).toBe(true);

    // And away again: the role moves, it is not kept by whoever held it first.
    const moved = service({ ownerEmail: "someone.else@example.test" });
    expect(moved.userFor(before.user.id)?.isOwner).toBe(false);
  });
});

describe("login", () => {
  it("issues a session for the right password", async () => {
    const auth = service();
    const account = await signedUp(auth);
    const result = await auth.login({ email: "ANA@example.test", password: PASSWORD }, NOW);
    expect(result.ok && result.value.user.id).toBe(account.user.id);
  });

  it("gives the same answer for a wrong password and for an email with no account", async () => {
    const auth = service();
    await signedUp(auth);
    const wrong = await auth.login({ email: "ana@example.test", password: `${PASSWORD}x` }, NOW);
    const nobody = await auth.login({ email: "nobody@example.test", password: PASSWORD }, NOW);
    expect(wrong).toEqual(nobody);
    expect(wrong).toMatchObject({ ok: false, error: "INVALID_CREDENTIALS" });
  });

  it("makes an email with no account cost a full password check, so timing cannot tell them apart", async () => {
    // The uniform error code above is half of the defense. Without the dummy hash in login, "no
    // such account" answers in well under a millisecond and "wrong password" in tens of them,
    // and that gap is the existence oracle. The gap is a whole scrypt against almost nothing, so
    // a quarter of it survives a loaded machine. Each email stays under MAX_FAILURES, because a
    // locked email answers without any check at all.
    const auth = service();
    await signedUp(auth);
    const cost = async (email: string): Promise<number> => {
      const start = performance.now();
      await auth.login({ email, password: "wrong wrong" }, NOW);
      return performance.now() - start;
    };
    await cost("nobody@example.test"); // the dummy hash is made once per process: not timed
    const real = Math.min(await cost("ana@example.test"), await cost("ana@example.test"), await cost("ana@example.test"));
    const nobody = Math.min(
      await cost("nobody@example.test"),
      await cost("nobody@example.test"),
      await cost("nobody@example.test"),
    );
    expect(nobody).toBeGreaterThan(real / 4);
  });

  it(`locks the account after ${MAX_FAILURES} failures, even against the right password`, async () => {
    const auth = service();
    await signedUp(auth);
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      expect(await auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW + i)).toMatchObject({
        error: "INVALID_CREDENTIALS",
      });
    }
    const locked = await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + MAX_FAILURES);
    expect(locked).toMatchObject({ ok: false, error: "LOCKED" });

    // And lets them back in once the lock has run out.
    const later = await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + MAX_FAILURES + LOCK_MS);
    expect(later.ok).toBe(true);
  });

  it("answers at most MAX_FAILURES of a wave of concurrent guesses, and stays locked", async () => {
    // Every guess in a wave passes the first lock check before any of them finishes, because the
    // check awaits scrypt. Guesses still in flight when the tenth failure locked the account used
    // to be answered anyway, and each wrong one wrote a fresh count over the lock it landed on:
    // eleven at once left the account unlocked with one failure counted, so waves of nineteen
    // were never capped at all.
    const auth = service();
    await signedUp(auth);
    const wave = await Promise.all(
      Array.from({ length: 2 * MAX_FAILURES - 1 }, () =>
        auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW),
      ),
    );
    const answered = wave.filter((result) => !result.ok && result.error === "INVALID_CREDENTIALS");
    expect(answered).toHaveLength(MAX_FAILURES);
    expect(wave.filter((result) => !result.ok && result.error === "LOCKED")).toHaveLength(MAX_FAILURES - 1);
    expect(await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + 1)).toMatchObject({
      ok: false,
      error: "LOCKED",
    });
  });

  it("refuses the right password when the lock lands while that password is being checked", async () => {
    const auth = service();
    await signedUp(auth);
    await auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW);
    const key = String(store.db.prepare("SELECT email_hash FROM login_lockouts").get()?.["email_hash"]);

    const inFlight = auth.login({ email: "ana@example.test", password: PASSWORD }, NOW);
    // What the tenth failure of a concurrent wave writes, landing while scrypt is still running.
    saveLockout(store, key, { failures: 0, lastFailureAt: NOW, lockedUntil: NOW + LOCK_MS });

    expect(await inFlight).toMatchObject({ ok: false, error: "LOCKED" });
    expect(await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + 1)).toMatchObject({
      error: "LOCKED",
    });
  });

  it("keeps a live lock through the once a minute prune", async () => {
    // Every other lockout test finishes inside a minute, so the prune never ran during any of
    // them, and a prune that deleted live locks would have ended every lock after one minute.
    const auth = service();
    await signedUp(auth);
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW);
    }
    expect(await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + 2 * 60_000)).toMatchObject({
      ok: false,
      error: "LOCKED",
    });
  });

  it("refuses, rather than failing, when the account is deleted while its password is checked", async () => {
    // DELETE /api/account from another device, landing during this login's scrypt. Issuing a
    // session for the row that is gone broke its foreign key, and the route answered 500.
    const auth = service();
    const account = await signedUp(auth);
    const inFlight = auth.login({ email: "ana@example.test", password: PASSWORD }, NOW);
    deleteUser(store, account.user.id);
    expect(await inFlight).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(count("refresh_tokens")).toBe(0);
    // And counted like any refusal, as an email with no account would be.
    expect(store.db.prepare("SELECT failures FROM login_lockouts").all()).toEqual([{ failures: 1 }]);
  });

  it("never hands an in-flight login the account that took its email meanwhile", async () => {
    // Deleted, and signed up again with the same email, while the old password was being checked.
    // That check proved the OLD account's password, so a session for the new one would belong to
    // someone who never proved anything about it. The account is read again by id, not by email.
    const auth = service();
    const account = await signedUp(auth);
    const otherHash = await hashPassword("somebody else's password");
    const inFlight = auth.login({ email: "ana@example.test", password: PASSWORD }, NOW);
    deleteUser(store, account.user.id);
    insertUser(store, {
      id: newUserId(),
      email: "ana@example.test",
      passwordHash: otherHash,
      displayName: "Not Ana",
      isOwner: false,
      createdAt: NOW,
    });
    expect(await inFlight).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(count("refresh_tokens")).toBe(0);
  });

  it("never prunes a lock still in force, however old its last failure", () => {
    // A lock lasts exactly as long as the failure window today, so a prune keyed on the window
    // alone can never reach a live lock, and the locked_until guard in pruneLockouts looks
    // redundant. It is what keeps a longer lock alive (a natural hardening), so it is pinned here
    // directly rather than left resting on the two constants being equal.
    saveLockout(store, "someone", {
      failures: 0,
      lastFailureAt: NOW - 10 * FAILURE_WINDOW_MS,
      lockedUntil: NOW + LOCK_MS,
    });
    pruneLockouts(store, NOW, FAILURE_WINDOW_MS);
    expect(findLockout(store, "someone")?.lockedUntil).toBe(NOW + LOCK_MS);
  });

  it("locks an email with no account exactly as it locks a real one", async () => {
    // A lock only real accounts could reach would answer "does this email exist" to anyone
    // willing to fail ten times.
    const auth = service();
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await auth.login({ email: "nobody@example.test", password: "wrong wrong" }, NOW);
    }
    expect(await auth.login({ email: "nobody@example.test", password: "wrong wrong" }, NOW)).toMatchObject({
      error: "LOCKED",
    });
  });

  it("does not store the email in the lockout table", async () => {
    const auth = service();
    await auth.login({ email: "nobody@example.test", password: "wrong wrong" }, NOW);
    const row = store.db.prepare("SELECT email_hash FROM login_lockouts").get();
    expect(String(row?.["email_hash"])).not.toContain("nobody");
  });

  it("resets the count on a successful login", async () => {
    const auth = service();
    await signedUp(auth);
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) {
      await auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW);
    }
    expect((await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW)).ok).toBe(true);
    expect(
      await auth.login({ email: "ana@example.test", password: "wrong wrong" }, NOW),
    ).toMatchObject({ error: "INVALID_CREDENTIALS" });
  });
});

describe("refresh", () => {
  it("rotates: a new refresh token every time, and the old one stops working", async () => {
    const auth = service();
    const session = await signedUp(auth);
    const next = auth.refresh({ refreshToken: session.refreshToken }, NOW + 1);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.refreshToken).not.toBe(session.refreshToken);
    expect(auth.verifyAccess(next.value.accessToken, NOW + 1)).toBe(session.user.id);
  });

  it("revokes the whole family when a used token is presented again", async () => {
    // The theft case: the attacker and the real client both hold the same token. Whichever uses
    // it second gives the game away, and the only safe answer is to end every session descended
    // from that sign in, including the one the thief just rotated into.
    const auth = service();
    const session = await signedUp(auth);
    const rotated = auth.refresh({ refreshToken: session.refreshToken }, NOW + 1);
    if (!rotated.ok) throw new Error("first rotation failed");

    const replay = auth.refresh({ refreshToken: session.refreshToken }, NOW + 2);
    expect(replay).toMatchObject({ ok: false, error: "INVALID_REFRESH" });

    // The descendant, which was valid a moment ago, is revoked with it.
    expect(auth.refresh({ refreshToken: rotated.value.refreshToken }, NOW + 3)).toMatchObject({
      ok: false,
      error: "INVALID_REFRESH",
    });
  });

  it("still catches a reused token after the once a minute prune has run", async () => {
    // A spent token has to outlive the prune, or presenting it again reads as a token nobody
    // issued: refused, but with the family left alive, so the thief's rotation keeps working.
    const auth = service();
    const session = await signedUp(auth);
    const rotated = auth.refresh({ refreshToken: session.refreshToken }, NOW + 1);
    if (!rotated.ok) throw new Error("first rotation failed");

    const later = NOW + 2 * 60_000;
    expect(auth.refresh({ refreshToken: session.refreshToken }, later)).toMatchObject({ ok: false });
    expect(auth.refresh({ refreshToken: rotated.value.refreshToken }, later + 1)).toMatchObject({
      ok: false,
      error: "INVALID_REFRESH",
    });
  });

  it("leaves a different sign in of the same user alone when one family is revoked", async () => {
    const auth = service();
    const first = await signedUp(auth);
    const second = await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW);
    if (!second.ok) throw new Error("login failed");
    auth.refresh({ refreshToken: first.refreshToken }, NOW + 1);
    auth.refresh({ refreshToken: first.refreshToken }, NOW + 2);
    expect(auth.refresh({ refreshToken: second.value.refreshToken }, NOW + 3).ok).toBe(true);
  });

  it("refuses an expired refresh token", async () => {
    const auth = service();
    const session = await signedUp(auth);
    expect(auth.refresh({ refreshToken: session.refreshToken }, NOW + REFRESH_TTL_MS)).toMatchObject({
      ok: false,
      error: "INVALID_REFRESH",
    });
  });

  it("refuses a token it never issued", () => {
    const auth = service();
    expect(auth.refresh({ refreshToken: randomBytes(32).toString("base64url") }, NOW)).toMatchObject({
      ok: false,
      error: "INVALID_REFRESH",
    });
  });

  it("keeps only a hash of the refresh token", async () => {
    const auth = service();
    const session = await signedUp(auth);
    const rows = store.db.prepare("SELECT token_hash FROM refresh_tokens").all();
    expect(rows.some((row) => String(row["token_hash"]) === session.refreshToken)).toBe(false);
  });
});

describe("logout", () => {
  it("revokes the family, so neither the token nor its descendants work afterwards", async () => {
    const auth = service();
    const session = await signedUp(auth);
    auth.logout({ refreshToken: session.refreshToken }, NOW + 1);
    expect(auth.refresh({ refreshToken: session.refreshToken }, NOW + 2)).toMatchObject({
      ok: false,
      error: "INVALID_REFRESH",
    });
  });

  it("is quiet about a token it does not know", () => {
    expect(() => service().logout({ refreshToken: "nope" }, NOW)).not.toThrow();
    expect(() => service().logout(null, NOW)).not.toThrow();
  });
});

describe("access tokens", () => {
  it("are refused once expired", async () => {
    const auth = service();
    const session = await signedUp(auth);
    expect(auth.verifyAccess(session.accessToken, NOW + ACCESS_TTL_MS)).toBe(null);
  });

  it("are refused for a user who no longer exists", async () => {
    const auth = service();
    const session = await signedUp(auth);
    store.db.prepare("DELETE FROM users").run();
    expect(auth.verifyAccess(session.accessToken, NOW)).toBe(null);
  });

  it("from another server's secret are refused", async () => {
    const other = new AuthService(openStore({ path: ":memory:" }), {
      secret: randomBytes(32).toString("hex"),
      signupMode: "open",
      ownerEmail: null,
    });
    const foreign = await other.signup({ email: "a@example.test", password: PASSWORD, displayName: "A" }, NOW);
    if (!foreign.ok) throw new Error("signup failed");
    expect(service().verifyAccess(foreign.value.accessToken, NOW)).toBe(null);
  });
});

describe("invites", () => {
  it("are stored hashed, never as the code", () => {
    const auth = service();
    const invite = auth.createInvite(null, NOW);
    const row = store.db.prepare("SELECT code_hash FROM invites").get();
    expect(String(row?.["code_hash"])).not.toContain(invite.code.replace(/-/g, ""));
  });

  it("are readable aloud: grouped Crockford base32 with no I, L, O or U", () => {
    const { code } = service().createInvite(null, NOW);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  });
});

describe("deleteAccount", () => {
  /** Every value in every column of every table, so "no row mentions this id" is checked literally. */
  function tablesHolding(value: string): string[] {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => String(row["name"]));
    const holding: string[] = [];
    for (const table of tables) {
      const columns = store.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c["name"]));
      for (const column of columns) {
        const hit = store.db.prepare(`SELECT 1 AS hit FROM ${table} WHERE ${column} = ? LIMIT 1`).get(value);
        if (hit) holding.push(`${table}.${column}`);
      }
    }
    return holding;
  }

  it("refuses the wrong password and leaves the account exactly as it was", async () => {
    const auth = service();
    const session = await signedUp(auth);
    const result = await auth.deleteAccount(session.user.id, { password: "not the password", userId: session.user.id }, NOW);
    expect(result).toEqual({ ok: false, error: "INVALID_CREDENTIALS" });
    expect(auth.userFor(session.user.id)).not.toBeNull();
    expect(auth.refresh({ refreshToken: session.refreshToken }, NOW).ok).toBe(true);
  });

  it("refuses a body that does not parse", async () => {
    const auth = service();
    const session = await signedUp(auth);
    expect(await auth.deleteAccount(session.user.id, {}, NOW)).toEqual({ ok: false, error: "INVALID_INPUT" });
  });

  it("logs a mismatch under the bearer's own id, never the id the request named", async () => {
    // The named id comes from the client, so it can be anything, an email included, and the
    // logger drops an email only under the key "email": logged as the named id, one went through
    // verbatim (measured in review). The line names the account the bearer is for. Read from
    // every console method a logger writes with: a second line at another level leaked past a
    // test watching one, moving warnings to another method failed it, and with info on
    // console.info a leak there went unseen (each measured in review).
    const auth = service();
    const ben = await signedUp(auth, "ben@example.test");
    const named = "someone.else@example.test";
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      expect(await auth.deleteAccount(ben.user.id, { password: PASSWORD, userId: named }, NOW)).toEqual({
        ok: false,
        error: "ACCOUNT_MISMATCH",
      });
      const lines = spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
      expect(lines.some((line) => line.includes("account.delete_mismatch") && line.includes(ben.user.id))).toBe(true);
      expect(lines.join("\n")).not.toContain(named);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuses a request that does not name the account it deletes", async () => {
    const auth = service();
    const session = await signedUp(auth);
    expect(await auth.deleteAccount(session.user.id, { password: PASSWORD }, NOW)).toEqual({
      ok: false,
      error: "INVALID_INPUT",
    });
    expect(auth.userFor(session.user.id)).not.toBeNull();
  });

  it("deletes only the account the request names, and refuses any other before checking the password", async () => {
    // Tabs of one browser share a sign in, so a tab can show an account it is no longer signed in
    // as. Review deleted the wrong account that way: the tab's bearer had moved to Ben, its form
    // was still Ana's, and the two shared a password. The request names the account the person
    // confirmed, and a bearer for any other is refused before the password is checked, so it
    // costs that account no lockout strike either.
    const auth = service();
    const ana = await signedUp(auth, "ana@example.test");
    const ben = await signedUp(auth, "ben@example.test");
    for (const password of [PASSWORD, "not the password"]) {
      expect(await auth.deleteAccount(ben.user.id, { password, userId: ana.user.id }, NOW)).toEqual({
        ok: false,
        error: "ACCOUNT_MISMATCH",
      });
    }
    expect(auth.userFor(ana.user.id)).not.toBeNull();
    expect(auth.userFor(ben.user.id)).not.toBeNull();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM login_lockouts").get()?.["n"]).toBe(0);
    // Before the lock check too, which comes before the password: whatever state the bearer's
    // account is in, the answer is about the account the request named.
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await auth.login({ email: "ben@example.test", password: `wrong ${i} wrong` }, NOW);
    }
    expect(await auth.deleteAccount(ben.user.id, { password: PASSWORD, userId: ana.user.id }, NOW)).toEqual({
      ok: false,
      error: "ACCOUNT_MISMATCH",
    });
  });

  it("counts wrong passwords toward the lockout, so a stolen access token cannot guess freely", async () => {
    const auth = service();
    const session = await signedUp(auth);
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      await auth.deleteAccount(session.user.id, { password: `wrong ${i} wrong`, userId: session.user.id }, NOW);
    }
    expect(await auth.deleteAccount(session.user.id, { password: PASSWORD, userId: session.user.id }, NOW)).toEqual({
      ok: false,
      error: "LOCKED",
    });
    expect(auth.userFor(session.user.id)).not.toBeNull();
  });

  it("stays locked through a wave of concurrent wrong passwords", async () => {
    // The same wave as login's: guesses in flight when the lock lands must not clear it.
    const auth = service();
    const session = await signedUp(auth);
    await Promise.all(
      Array.from({ length: 2 * MAX_FAILURES - 1 }, (_, i) =>
        auth.deleteAccount(session.user.id, { password: `wrong ${i} wrong`, userId: session.user.id }, NOW),
      ),
    );
    expect(await auth.deleteAccount(session.user.id, { password: PASSWORD, userId: session.user.id }, NOW + 1)).toEqual({
      ok: false,
      error: "LOCKED",
    });
    expect(auth.userFor(session.user.id)).not.toBeNull();
  });

  it("refuses the right password when the lock lands while that password is being checked", async () => {
    const auth = service();
    const session = await signedUp(auth);
    await auth.deleteAccount(session.user.id, { password: "wrong wrong", userId: session.user.id }, NOW);
    const key = String(store.db.prepare("SELECT email_hash FROM login_lockouts").get()?.["email_hash"]);

    const inFlight = auth.deleteAccount(session.user.id, { password: PASSWORD, userId: session.user.id }, NOW);
    saveLockout(store, key, { failures: 0, lastFailureAt: NOW, lockedUntil: NOW + LOCK_MS });

    expect(await inFlight).toEqual({ ok: false, error: "LOCKED" });
    expect(auth.userFor(session.user.id)).not.toBeNull();
  });

  it("with the right password removes every trace: no table holds the id, and no session works", async () => {
    const auth = service({ ownerEmail: "ana@example.test" });
    const session = await signedUp(auth, "ana@example.test");
    const id = session.user.id;
    // A second sign in, an invite this user minted, and one they spent (their own signup).
    const second = await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW);
    auth.createInvite(id, NOW);
    // Rows in every per user table.
    store.db.prepare("INSERT INTO user_preferences (user_id, dialect, ui_dialect, updated_at) VALUES (?, 'es-AR', NULL, ?)").run(id, NOW);
    store.db
      .prepare("INSERT INTO user_glossary (user_id, position, source, target, source_dialect, target_dialect) VALUES (?, 0, 'a', 'b', 'es-AR', 'en-US')")
      .run(id);
    store.db
      .prepare("INSERT INTO call_history (id, user_id, room_hash, peer_user_id, started_at) VALUES ('c1', ?, 'h', NULL, ?)")
      .run(id, NOW);
    expect(tablesHolding(id).length).toBeGreaterThan(3);

    const deleted: string[] = [];
    auth.onAccountDeleted((userId) => deleted.push(userId));
    const result = await auth.deleteAccount(id, { password: PASSWORD, userId: id }, NOW + 1);

    expect(result).toEqual({ ok: true, value: null });
    expect(tablesHolding(id)).toEqual([]);
    expect(deleted).toEqual([id]);
    expect((await auth.login({ email: "ana@example.test", password: PASSWORD }, NOW + 2)).ok).toBe(false);
    expect(auth.refresh({ refreshToken: session.refreshToken }, NOW + 2)).toEqual({ ok: false, error: "INVALID_REFRESH" });
    if (second.ok) {
      expect(auth.refresh({ refreshToken: second.value.refreshToken }, NOW + 2).ok).toBe(false);
    }
    expect(auth.verifyAccess(session.accessToken, NOW + 2)).toBeNull();
  });

  it("keeps the peer's call history, with nobody on the other end", async () => {
    const auth = service();
    const ana = await signedUp(auth, "ana@example.test");
    const ben = await signedUp(auth, "ben@example.test");
    store.db
      .prepare("INSERT INTO call_history (id, user_id, room_hash, peer_user_id, started_at, ended_at) VALUES ('b1', ?, 'h', ?, ?, ?)")
      .run(ben.user.id, ana.user.id, NOW, NOW + 60_000);

    expect((await auth.deleteAccount(ana.user.id, { password: PASSWORD, userId: ana.user.id }, NOW)).ok).toBe(true);

    expect(store.db.prepare("SELECT user_id, room_hash, peer_user_id, started_at, ended_at FROM call_history").all()).toEqual([
      { user_id: ben.user.id, room_hash: "h", peer_user_id: null, started_at: NOW, ended_at: NOW + 60_000 },
    ]);
  });

  it("refuses an account that no longer exists", async () => {
    const auth = service();
    expect(await auth.deleteAccount("gone", { password: PASSWORD, userId: "gone" }, NOW)).toEqual({
      ok: false,
      error: "UNAUTHENTICATED",
    });
  });

  it("leaves nothing of the account readable in the database files, not just in its tables", async () => {
    // The UI promises the account is deleted. SQLite marks a deleted row as free space rather than
    // overwriting it, and the WAL keeps older copies of every page it wrote, so after a successful
    // delete the email, the name and a glossary term were still readable in translatv.db and its
    // WAL (measured in review). So the raw bytes of both files are read here. Reorganized pages can
    // also keep older copies of rows in their unused space, which only rewriting the file clears;
    // review found deleted ids there after churn that one account in a fresh file cannot produce,
    // so the rewrite itself is pinned too: a rewritten file has no free pages left.
    const dir = mkdtempSync(join(tmpdir(), "tv-erase-"));
    const path = join(dir, "translatv.db");
    const onDisk = openStore({ path });
    try {
      const marker = randomBytes(8).toString("hex");
      const auth = new AuthService(onDisk, { secret: SECRET, signupMode: "open", ownerEmail: null });
      const signup = await auth.signup(
        { email: `erase-${marker}@example.test`, password: PASSWORD, displayName: `Name ${marker}` },
        NOW,
      );
      if (!signup.ok) throw new Error(`signup failed: ${signup.error}`);
      // A full glossary spans whole pages, which a delete frees outright. The rewrite clears them
      // here whatever secure_delete is set to; store.test.ts pins secure_delete itself, for a
      // deletion the rewrite never reaches.
      const saved = new AccountService(onDisk).setGlossary(signup.value.user.id, {
        entries: Array.from({ length: LIMITS.glossaryEntries }, (_, i) => ({
          source: `term${i} ${marker}`.padEnd(LIMITS.glossaryTerm, "s"),
          target: marker.padEnd(LIMITS.glossaryTranslation, "t"),
          sourceDialect: "es-AR",
          targetDialect: "en-US",
        })),
      });
      expect(saved.ok).toBe(true);
      // And a correction saved after a call, through the path a call takes (the corrections pull
      // request). It lands in the same table, so the same erase has to reach it.
      const corrections = new AccountService(onDisk);
      corrections.saveCorrections(signup.value.user.id, [
        { source: `fixed ${marker}`, target: `fix ${marker}`, sourceDialect: "es-AR", targetDialect: "en-US" },
      ]);
      expect(corrections.glossaryFor(signup.value.user.id)[0]?.source).toBe(`fixed ${marker}`);
      const readable = () =>
        [path, `${path}-wal`].filter((file) => existsSync(file) && readFileSync(file).includes(marker));
      // The control: before the delete the marker is there to be found, so "absent" below means
      // something.
      expect(readable().length).toBeGreaterThan(0);

      expect((await auth.deleteAccount(signup.value.user.id, { password: PASSWORD, userId: signup.value.user.id }, NOW + 1)).ok).toBe(true);
      expect(readable()).toEqual([]);
      expect(onDisk.db.prepare("PRAGMA freelist_count").get()).toEqual({ freelist_count: 0 });
    } finally {
      onDisk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not stall while another connection holds the database, and erases once it is free", async () => {
    // A backup or an operator's shell holding a read. The erase must not wait it out (the whole
    // server stalled five seconds, measured), and must still happen: it is retried later.
    const dir = mkdtempSync(join(tmpdir(), "tv-erase-"));
    const path = join(dir, "translatv.db");
    const onDisk = openStore({ path });
    const reader = new DatabaseSync(path);
    const later: Array<() => void> = [];
    try {
      const marker = randomBytes(8).toString("hex");
      const auth = new AuthService(onDisk, {
        secret: SECRET,
        signupMode: "open",
        ownerEmail: null,
        schedule: (run) => later.push(run),
      });
      const signup = await auth.signup(
        { email: `erase-${marker}@example.test`, password: PASSWORD, displayName: `Name ${marker}` },
        NOW,
      );
      if (!signup.ok) throw new Error(`signup failed: ${signup.error}`);
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM users").get();

      const started = performance.now();
      expect((await auth.deleteAccount(signup.value.user.id, { password: PASSWORD, userId: signup.value.user.id }, NOW + 1)).ok).toBe(true);
      expect(performance.now() - started).toBeLessThan(2500);
      expect(later).toHaveLength(1);

      reader.exec("COMMIT");
      later.shift()?.();
      expect(later).toHaveLength(0);
      expect([path, `${path}-wal`].filter((file) => existsSync(file) && readFileSync(file).includes(marker))).toEqual([]);
    } finally {
      reader.close();
      onDisk.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A file store, a second connection to it (a backup, an operator's shell), and accounts whose
   * email and name carry a marker, for the erase tests below. `readable` lists the markers either
   * file still holds.
   */
  async function eraseRig(accounts: number) {
    const dir = mkdtempSync(join(tmpdir(), "tv-erase-"));
    const path = join(dir, "translatv.db");
    const onDisk = openStore({ path });
    const reader = new DatabaseSync(path);
    const later: Array<{ run: () => void; ms: number }> = [];
    let erases = 0;
    const counted: Store = {
      ...onDisk,
      erase: () => {
        erases += 1;
        return onDisk.erase();
      },
    };
    const auth = new AuthService(counted, {
      secret: SECRET,
      signupMode: "open",
      ownerEmail: null,
      schedule: (run, ms) => later.push({ run, ms }),
    });
    const made: Array<{ id: string; marker: string }> = [];
    for (let i = 0; i < accounts; i += 1) {
      const marker = randomBytes(8).toString("hex");
      const signup = await auth.signup(
        { email: `erase-${marker}@example.test`, password: PASSWORD, displayName: `Name ${marker}` },
        NOW,
      );
      if (!signup.ok) throw new Error(`signup failed: ${signup.error}`);
      made.push({ id: signup.value.user.id, marker });
    }
    return {
      auth,
      reader,
      later,
      made,
      erases: () => erases,
      remove: (id: string) => auth.deleteAccount(id, { password: PASSWORD, userId: id }, NOW + 1),
      readable: () =>
        made
          .map((account) => account.marker)
          .filter((marker) => [path, `${path}-wal`].some((file) => existsSync(file) && readFileSync(file).includes(marker))),
      close: () => {
        reader.close();
        onDisk.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("keeps one retry for every deletion made while the database is busy, not one each", async () => {
    // Each deletion used to start retries of its own, each rewriting the whole file every minute:
    // five deletions beside one reader made five chains and 295 attempts (measured in review).
    // One rewrite erases every deleted row, so one retry covers them all.
    const rig = await eraseRig(3);
    try {
      rig.reader.exec("BEGIN");
      rig.reader.prepare("SELECT count(*) AS n FROM users").get();
      for (const account of rig.made) expect((await rig.remove(account.id)).ok).toBe(true);
      expect(rig.later).toHaveLength(1);

      rig.reader.exec("COMMIT");
      rig.later.shift()?.run();
      expect(rig.later).toHaveLength(0);
      expect(rig.readable()).toEqual([]);
    } finally {
      rig.close();
    }
  });

  it("does not rewrite the file again for a retry left over once a later deletion has erased everything", async () => {
    // Each rewrite holds the server for a time that grows with the file (about 0.7 s at 100 MB).
    const rig = await eraseRig(2);
    try {
      rig.reader.exec("BEGIN");
      rig.reader.prepare("SELECT count(*) AS n FROM users").get();
      expect((await rig.remove(rig.made[0]!.id)).ok).toBe(true);
      expect(rig.later).toHaveLength(1);
      rig.reader.exec("COMMIT");
      expect((await rig.remove(rig.made[1]!.id)).ok).toBe(true);
      expect(rig.readable()).toEqual([]);

      const before = rig.erases();
      rig.later.shift()?.run();
      expect(rig.erases()).toBe(before);
    } finally {
      rig.close();
    }
  });

  it("retries at least ten seconds apart, for at least half an hour after the latest deletion, then stops", async () => {
    // Both bounds were untested: with the cap removed the retries never ended, and with no delay
    // the real timer would have run them back to back (both green in review). The half hour
    // counts from the LATEST deletion, so a deletion late in a busy spell still gets its retries.
    const rig = await eraseRig(3);
    try {
      rig.reader.exec("BEGIN");
      rig.reader.prepare("SELECT count(*) AS n FROM users").get();
      expect((await rig.remove(rig.made[0]!.id)).ok).toBe(true);
      for (let i = 0; i < 10; i += 1) rig.later.shift()?.run();
      expect((await rig.remove(rig.made[1]!.id)).ok).toBe(true);

      let runs = 0;
      let waited = 0;
      while (rig.later.length > 0 && runs < 1000) {
        const next = rig.later.shift()!;
        expect(next.ms).toBeGreaterThanOrEqual(10_000);
        waited += next.ms;
        next.run();
        runs += 1;
      }
      expect(rig.later).toHaveLength(0);
      expect(runs).toBe(ERASE_ATTEMPTS - 1);
      expect(waited).toBeGreaterThanOrEqual(30 * 60 * 1000);

      // Given up, the rows wait for the next deletion, whose rewrite takes theirs too.
      rig.reader.exec("COMMIT");
      expect((await rig.remove(rig.made[2]!.id)).ok).toBe(true);
      expect(rig.readable()).toEqual([]);
    } finally {
      rig.close();
    }
  });

  it("keeps the erase owed after a failure, so a retry already scheduled still makes it", async () => {
    // A failure other than a busy database schedules nothing new, but the rows are still owed.
    // Forgetting them turned the retry already scheduled into a no-op (green in review).
    const answers: Array<boolean | Error> = [false, new Error("disk I/O error"), true];
    let calls = 0;
    const later: Array<() => void> = [];
    const scripted: Store = {
      ...store,
      erase: () => {
        const answer = answers[calls] ?? true;
        calls += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    const auth = new AuthService(scripted, {
      secret: SECRET,
      signupMode: "invite",
      ownerEmail: null,
      schedule: (run) => later.push(run),
    });
    const ana = await signedUp(auth, "ana@example.test");
    const ben = await signedUp(auth, "ben@example.test");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await auth.deleteAccount(ana.user.id, { password: PASSWORD, userId: ana.user.id }, NOW)).ok).toBe(true);
      expect(later).toHaveLength(1);
      expect((await auth.deleteAccount(ben.user.id, { password: PASSWORD, userId: ben.user.id }, NOW)).ok).toBe(true);
      later.shift()?.();
      expect(calls).toBe(3);
    } finally {
      error.mockRestore();
    }
  });

  it("closes the account's sockets even when erasing the files throws", async () => {
    // Rewriting the files is housekeeping after the delete. A failure in it must not skip what the
    // deletion itself has to do, such as closing the account's live sockets.
    const failing: Store = {
      ...store,
      erase: () => {
        throw new Error("disk I/O error");
      },
    };
    const auth = new AuthService(failing, { secret: SECRET, signupMode: "invite", ownerEmail: null });
    const account = await signedUp(auth);
    const deleted: string[] = [];
    auth.onAccountDeleted((userId) => deleted.push(userId));
    expect(await auth.deleteAccount(account.user.id, { password: PASSWORD, userId: account.user.id }, NOW)).toEqual({ ok: true, value: null });
    expect(deleted).toEqual([account.user.id]);
  });
});
