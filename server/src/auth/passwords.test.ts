import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dummyHash, hashPassword, MIN_PASSWORD_LENGTH, passwordIsAcceptable, verifyPassword } from "./passwords.js";

// Generated, never written down: a password shaped literal reads as a committed credential to a
// scanner and to a person skimming the file.
const PASSWORD = randomBytes(12).toString("hex");

describe("password hashing", () => {
  it("verifies the password it hashed", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, stored)).toBe(true);
  });

  it("refuses a different password", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(await verifyPassword(`${PASSWORD}x`, stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts per hash, so two users with one password store different strings", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("stores a self describing string that names its algorithm and parameters", async () => {
    const stored = await hashPassword(PASSWORD);
    expect(stored).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    expect(stored).not.toContain(PASSWORD);
  });

  it("answers false rather than throwing on a stored value it cannot read", async () => {
    for (const junk of ["", "scrypt", "bcrypt$x$y$z", "scrypt$N=abc,r=8,p=1$AA$AA", "scrypt$N=16384,r=8,p=1$$"]) {
      expect(await verifyPassword(PASSWORD, junk)).toBe(false);
    }
  });

  it("refuses parameters large enough to be a denial of service", async () => {
    // A stored value is trusted input in principle, but a corrupted or hostile row must not be
    // able to make one login allocate gigabytes.
    expect(await verifyPassword(PASSWORD, "scrypt$N=1073741824,r=8,p=1$AAAA$AAAA")).toBe(false);
  });
});

describe("the dummy hash a login for a missing account verifies against", () => {
  // What makes "no such account" cost the same as "wrong password" (service.ts, login). The timing
  // test there catches a dummy that costs nothing; these catch the subtler ones, which it cannot:
  // a dummy rebuilt per call (two scrypts, double the time) or made with cheaper parameters (half
  // the time) both leave "no account" measurably different, and both passed a quarter margin.
  it("is made once and then reused, so a missing account pays one scrypt, not two", async () => {
    // Compared by value, not by promise identity. A dummy rebuilt on every call hashes a fresh
    // random password with a fresh salt, so it never comes out the same twice. An async function
    // caching the string (what a lint autofix produces) is just as cheap, and must pass.
    expect(await dummyHash()).toBe(await dummyHash());
  });

  it("uses exactly the parameters a real password is hashed with today", async () => {
    const params = (stored: string) => stored.split("$").slice(0, 2).join("$");
    expect(params(await dummyHash())).toBe(params(await hashPassword(PASSWORD)));
  });
});

describe("password policy", () => {
  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(passwordIsAcceptable("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(passwordIsAcceptable("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
  });

  it("caps the length, so a megabyte password cannot be used to burn CPU", () => {
    expect(passwordIsAcceptable("a".repeat(1025))).toBe(false);
  });
});
