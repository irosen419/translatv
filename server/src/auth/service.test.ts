// The account rules, against a real in memory database.
//
// Everything that decides who gets a session lives in AuthService, and the HTTP layer only maps
// its results to status codes, so this is where the rules are proved. routes.test.ts proves the
// mapping and the limits over real HTTP.

import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStore, type Store } from "../store/index.js";
import { ACCESS_TTL_MS } from "./accessTokens.js";
import { AuthService, LOCK_MS, MAX_FAILURES, REFRESH_TTL_MS, type AuthOptions } from "./service.js";

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
