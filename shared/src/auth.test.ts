import { describe, expect, it } from "vitest";

import {
  canonicalInvite,
  formatInviteInput,
  INVITE_CODE_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  unmetPasswordRules,
} from "./auth.js";

describe("the password policy", () => {
  it("is eight characters with a lowercase letter, an uppercase letter, a number and a symbol", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(unmetPasswordRules("Abcdef1!")).toEqual([]);
  });

  it("names every rule a password misses, in the order the form lists them", () => {
    expect(unmetPasswordRules("")).toEqual(["length", "lowercase", "uppercase", "digit", "symbol"]);
    expect(unmetPasswordRules("abcdefgh")).toEqual(["uppercase", "digit", "symbol"]);
    expect(unmetPasswordRules("ABCDEFG1")).toEqual(["lowercase", "symbol"]);
    expect(unmetPasswordRules("Abc1!")).toEqual(["length"]);
  });

  it("counts letters with accents, so a Spanish speaker's Ñ or á is a letter like any other", () => {
    expect(unmetPasswordRules("Ñandú2024!")).toEqual([]);
    expect(unmetPasswordRules("ÁRBOL2024!")).toEqual(["lowercase"]);
  });

  it("does not count a space as the symbol", () => {
    expect(unmetPasswordRules("Abcdef1 x")).toEqual(["symbol"]);
  });

  it("still refuses a password past the maximum, as a length problem", () => {
    expect(unmetPasswordRules(`Aa1!${"a".repeat(MAX_PASSWORD_LENGTH)}`)).toEqual(["length"]);
  });
});

describe("invite codes", () => {
  it("formats what a person types as the code's own shape: uppercase, in dashed groups of four", () => {
    expect(formatInviteInput("2cpw")).toBe("2CPW");
    expect(formatInviteInput("2cpwg")).toBe("2CPW-G");
    expect(formatInviteInput("2cpwgdfbqtvt")).toBe("2CPW-GDFB-QTVT");
  });

  it("drops anything that cannot be in a code, and stops at the code's length", () => {
    expect(formatInviteInput("2C PW_GD.FB/QT@VT")).toBe("2CPW-GDFB-QTVT");
    expect(formatInviteInput("2CPW-GDFB-QTVT-EXTRA")).toBe("2CPW-GDFB-QTVT");
    expect(formatInviteInput("é!ñ")).toBe("");
  });

  it("reads a lookalike letter as the character the code really has", () => {
    // The alphabet has no O, I, L or U, so each is folded to the one it is mistaken for.
    expect(formatInviteInput("oilu")).toBe("011V");
  });

  it("keeps a dash typed by hand without doubling it", () => {
    expect(formatInviteInput("2CPW-")).toBe("2CPW-");
    expect(formatInviteInput("2CPW--G")).toBe("2CPW-G");
  });

  it("gives the canonical code only for a complete, valid one", () => {
    expect(canonicalInvite("2cpw-gdfb-qtvt")).toBe("2CPWGDFBQTVT");
    expect(canonicalInvite(" 2CPW GDFB QTVT ")).toBe("2CPWGDFBQTVT");
    expect(canonicalInvite("2CPW-GDFB-QTV")).toBeNull();
    expect(canonicalInvite("2CPW-GDFB-QTVT1")).toBeNull();
    expect(canonicalInvite("2CPW-GDFB-QT<T")).toBeNull();
    expect(canonicalInvite("")).toBeNull();
    expect(INVITE_CODE_LENGTH).toBe(12);
  });
});
