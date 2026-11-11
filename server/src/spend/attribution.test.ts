// Tests for spend attribution: which environment a paid call ran in, and whose call it was.
//
// The two properties that matter: an unset environment labels itself (a laptop says "local"
// without anyone remembering to set anything), and a person's tag is stable for one key but
// cannot be turned back into their account id by anyone reading the public ledger.

import { describe, expect, it } from "vitest";

import { resolveSpendEnv, spendTagKey, userTag, USER_TAG_PATTERN } from "./attribution.js";

describe("resolveSpendEnv", () => {
  it("labels an unset environment local outside production", () => {
    expect(resolveSpendEnv(undefined, false)).toBe("local");
    expect(resolveSpendEnv("", false)).toBe("local");
    expect(resolveSpendEnv("   ", false)).toBe("local");
  });

  it("labels an unset environment production in production", () => {
    expect(resolveSpendEnv(undefined, true)).toBe("production");
  });

  it("takes an explicit name, trimmed and lowercased", () => {
    expect(resolveSpendEnv("pi", true)).toBe("pi");
    expect(resolveSpendEnv("  Render-Staging ", true)).toBe("render-staging");
    expect(resolveSpendEnv("local", true)).toBe("local");
  });

  it("refuses a name that would make a messy column, naming the setting", () => {
    for (const bad of ["my laptop", "-pi", "pi-", "pi_1", "x".repeat(33), "ñ"]) {
      expect(() => resolveSpendEnv(bad, false)).toThrow(/SPEND_ENV/);
    }
  });
});

describe("userTag", () => {
  const key = spendTagKey("a test secret that is long enough to be a real one");

  it("is 16 lowercase hex characters", () => {
    expect(userTag(key, "user-1")).toMatch(USER_TAG_PATTERN);
  });

  it("is stable for one person under one key", () => {
    expect(userTag(key, "user-1")).toBe(userTag(key, "user-1"));
  });

  it("differs between people", () => {
    expect(userTag(key, "user-1")).not.toBe(userTag(key, "user-2"));
  });

  it("differs under another key, so the public ledger alone cannot be matched to accounts", () => {
    const other = spendTagKey("another secret entirely, also long enough");
    expect(userTag(other, "user-1")).not.toBe(userTag(key, "user-1"));
  });

  it("is not the plain sha256 of the id, which anyone could recompute from an account id", async () => {
    const { createHash } = await import("node:crypto");
    const plain = createHash("sha256").update("user-1").digest("hex").slice(0, 16);
    expect(userTag(key, "user-1")).not.toBe(plain);
  });

  it("does not reuse the sign in key directly", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "a test secret that is long enough to be a real one";
    const direct = createHmac("sha256", secret).update("user-1").digest("hex").slice(0, 16);
    expect(userTag(key, "user-1")).not.toBe(direct);
  });
});
