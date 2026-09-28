import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authSecretRefusal, MIN_SECRET_LENGTH, resolveAuthSecret } from "./secret.js";

const GOOD = randomBytes(32).toString("hex");

describe("the AUTH_SECRET boot guard", () => {
  it("refuses production with no secret, and says which variable", () => {
    const refusal = authSecretRefusal({ isProduction: true, secret: null });
    expect(refusal).toContain("AUTH_SECRET is not set");
  });

  it("refuses production with a secret too short to be random", () => {
    const refusal = authSecretRefusal({ isProduction: true, secret: "a".repeat(MIN_SECRET_LENGTH - 1) });
    expect(refusal).toContain("AUTH_SECRET is too short");
  });

  it("lets production through with a real secret", () => {
    expect(authSecretRefusal({ isProduction: true, secret: GOOD })).toBe(null);
  });

  it("never refuses development, which generates one instead", () => {
    expect(authSecretRefusal({ isProduction: false, secret: null })).toBe(null);
  });
});

describe("resolveAuthSecret", () => {
  it("uses the configured secret as is", () => {
    expect(resolveAuthSecret(GOOD)).toEqual({ secret: GOOD, generated: false });
  });

  it("generates a fresh random one per process when none is configured", () => {
    const a = resolveAuthSecret(null);
    const b = resolveAuthSecret(null);
    expect(a.generated).toBe(true);
    expect(a.secret.length).toBeGreaterThanOrEqual(MIN_SECRET_LENGTH);
    expect(a.secret).not.toBe(b.secret);
  });
});
