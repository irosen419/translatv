// The per user data API's schemas. Like the wire protocol's, these are the server's input
// validation as well as the types, so what they refuse is the boundary.

import { describe, expect, it } from "vitest";

import {
  CALLS_PAGE_MAX,
  callsQuery,
  deleteAccountRequest,
  glossaryDocument,
  preferences,
} from "./account.js";
import { LIMITS } from "./protocol.js";

const entry = { source: "chamba", target: "job", sourceDialect: "es-MX", targetDialect: "en-US" };

describe("preferences", () => {
  it("accepts two known dialects, or null for either", () => {
    expect(preferences.safeParse({ dialect: "es-AR", uiDialect: "en-US" }).success).toBe(true);
    expect(preferences.safeParse({ dialect: null, uiDialect: null }).success).toBe(true);
  });

  it("refuses an unknown dialect, a missing field, and an unknown key", () => {
    expect(preferences.safeParse({ dialect: "xx-XX", uiDialect: null }).success).toBe(false);
    expect(preferences.safeParse({ dialect: "es-AR" }).success).toBe(false);
    expect(preferences.safeParse({ dialect: null, uiDialect: null, extra: 1 }).success).toBe(false);
  });
});

describe("glossaryDocument", () => {
  it("accepts up to the wire limit of entries, and no more", () => {
    const full = Array.from({ length: LIMITS.glossaryEntries }, (_, i) => ({ ...entry, source: `t${i}` }));
    expect(glossaryDocument.safeParse({ entries: full }).success).toBe(true);
    expect(glossaryDocument.safeParse({ entries: [...full, entry] }).success).toBe(false);
  });

  it("holds each term to the wire limits for a glossary entry", () => {
    const longSource = { ...entry, source: "a".repeat(LIMITS.glossaryTerm + 1) };
    const longTarget = { ...entry, target: "a".repeat(LIMITS.glossaryTranslation + 1) };
    expect(glossaryDocument.safeParse({ entries: [longSource] }).success).toBe(false);
    expect(glossaryDocument.safeParse({ entries: [longTarget] }).success).toBe(false);
    const atLimit = { ...entry, source: "a".repeat(LIMITS.glossaryTerm), target: "b".repeat(LIMITS.glossaryTranslation) };
    expect(glossaryDocument.safeParse({ entries: [atLimit] }).success).toBe(true);
  });

  it("refuses a term that is empty once cleaned, and an unknown dialect", () => {
    expect(glossaryDocument.safeParse({ entries: [{ ...entry, source: "   " }] }).success).toBe(false);
    expect(glossaryDocument.safeParse({ entries: [{ ...entry, target: "" }] }).success).toBe(false);
    expect(glossaryDocument.safeParse({ entries: [{ ...entry, targetDialect: "zz" }] }).success).toBe(false);
  });

  it("accepts an empty list, which is how a glossary is cleared", () => {
    expect(glossaryDocument.safeParse({ entries: [] }).success).toBe(true);
  });
});

describe("callsQuery", () => {
  it("defaults the page size and caps it", () => {
    expect(callsQuery.parse({})).toEqual({ limit: 20 });
    expect(callsQuery.parse({ limit: "5" })).toEqual({ limit: 5 });
    expect(callsQuery.safeParse({ limit: String(CALLS_PAGE_MAX + 1) }).success).toBe(false);
    expect(callsQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("takes an opaque cursor, bounded", () => {
    expect(callsQuery.parse({ before: "abc" })).toEqual({ limit: 20, before: "abc" });
    expect(callsQuery.safeParse({ before: "x".repeat(200) }).success).toBe(false);
  });
});

describe("deleteAccountRequest", () => {
  it("needs a password", () => {
    expect(deleteAccountRequest.safeParse({ password: "long enough" }).success).toBe(true);
    expect(deleteAccountRequest.safeParse({ password: "" }).success).toBe(false);
    expect(deleteAccountRequest.safeParse({}).success).toBe(false);
  });
});
