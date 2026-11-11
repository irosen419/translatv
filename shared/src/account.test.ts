// The per user data API's schemas. Like the wire protocol's, these are the server's input
// validation as well as the types, so what they refuse is the boundary.

import { describe, expect, it } from "vitest";

import {
  blocksResponse,
  CALLS_PAGE_MAX,
  callsQuery,
  contactRef,
  deleteAccountRequest,
  glossaryDocument,
  ownerReport,
  preferences,
  REPORT_DETAILS_MAX,
  REPORT_REASONS,
  reportReceipt,
  reportRequest,
  reportsResponse,
  reviewReportRequest,
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
    expect(deleteAccountRequest.safeParse({ password: "long enough", userId: "u1" }).success).toBe(true);
    expect(deleteAccountRequest.safeParse({ password: "", userId: "u1" }).success).toBe(false);
    expect(deleteAccountRequest.safeParse({}).success).toBe(false);
  });

  it("needs the id of the account it deletes", () => {
    expect(deleteAccountRequest.safeParse({ password: "long enough" }).success).toBe(false);
    expect(deleteAccountRequest.safeParse({ password: "long enough", userId: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Safety: blocks, reports, and the owner's review of them
// ---------------------------------------------------------------------------

describe("contactRef (block and unblock)", () => {
  it("names a person by the per viewer contactId, bounded", () => {
    expect(contactRef.safeParse({ contactId: "mN4bV7cX0zL3kJ6hG9fD2s" }).success).toBe(true);
    expect(contactRef.safeParse({ contactId: "" }).success).toBe(false);
    expect(contactRef.safeParse({ contactId: "x".repeat(65) }).success).toBe(false);
    expect(contactRef.safeParse({}).success).toBe(false);
  });

  it("refuses an account id field, so nobody mistakes it for a way to name an account", () => {
    expect(contactRef.safeParse({ contactId: "c1", userId: "u1" }).success).toBe(false);
  });
});

describe("reportRequest", () => {
  const minimal = { contactId: "c1", reason: "harassment" };

  it("takes exactly the fixed reasons", () => {
    expect([...REPORT_REASONS]).toEqual(["harassment", "hate", "sexual_content", "spam_or_scam", "underage", "other"]);
    for (const reason of REPORT_REASONS) expect(reportRequest.safeParse({ ...minimal, reason }).success).toBe(true);
    expect(reportRequest.safeParse({ ...minimal, reason: "rude" }).success).toBe(false);
  });

  it("takes optional details up to REPORT_DETAILS_MAX characters once cleaned", () => {
    expect(REPORT_DETAILS_MAX).toBe(500);
    expect(reportRequest.safeParse({ ...minimal, details: "a".repeat(REPORT_DETAILS_MAX) }).success).toBe(true);
    expect(reportRequest.safeParse({ ...minimal, details: "a".repeat(REPORT_DETAILS_MAX + 1) }).success).toBe(false);
    expect(reportRequest.parse({ ...minimal, details: "  said\u0007 things  " }).details).toBe("said  things");
  });

  it("takes an optional also block flag", () => {
    expect(reportRequest.parse({ ...minimal, alsoBlock: true }).alsoBlock).toBe(true);
    expect(reportRequest.parse(minimal).alsoBlock).toBeUndefined();
    expect(reportRequest.safeParse({ ...minimal, alsoBlock: "yes" }).success).toBe(false);
  });

  it("needs a contact and a reason", () => {
    expect(reportRequest.safeParse({ reason: "hate" }).success).toBe(false);
    expect(reportRequest.safeParse({ contactId: "c1" }).success).toBe(false);
  });
});

describe("the owner's report shapes", () => {
  const report = {
    id: "r1",
    reason: "spam_or_scam",
    details: null,
    status: "open",
    createdAt: 1,
    reviewedAt: null,
    reporter: { userId: "u1", displayName: "Ana" },
    reported: null,
  };

  it("say a deleted account on either end as null", () => {
    expect(ownerReport.safeParse(report).success).toBe(true);
    expect(reportsResponse.safeParse({ reports: [report] }).success).toBe(true);
  });

  it("have exactly two statuses", () => {
    expect(ownerReport.safeParse({ ...report, status: "reviewed", reviewedAt: 2 }).success).toBe(true);
    expect(ownerReport.safeParse({ ...report, status: "closed" }).success).toBe(false);
  });

  it("review a report by its id", () => {
    expect(reviewReportRequest.safeParse({ id: "r1" }).success).toBe(true);
    expect(reviewReportRequest.safeParse({ id: "" }).success).toBe(false);
  });
});

describe("blocksResponse", () => {
  it("lists people by contactId and name, with when they were blocked", () => {
    const body = { blocked: [{ contactId: "c1", displayName: "Ben", blockedAt: 5 }] };
    expect(blocksResponse.safeParse(body).success).toBe(true);
    expect(blocksResponse.safeParse({ blocked: [{ contactId: "c1", blockedAt: 5 }] }).success).toBe(false);
  });
});

describe("reportReceipt", () => {
  it("says the report's id and whether the person is now blocked", () => {
    expect(reportReceipt.safeParse({ id: "r1", blocked: false }).success).toBe(true);
    expect(reportReceipt.safeParse({ id: "r1" }).success).toBe(false);
  });
});
