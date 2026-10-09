// The schemas here are the server's input validation, not just types, so what they accept and
// reject is a security boundary rather than a convenience.

import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  errorCode,
  parseClientMessage,
  TRANSLATION_FAILURE_CODES,
  translationFailureCode,
} from "./protocol.js";

/** parseClientMessage reports a verdict rather than throwing, so a bad frame is a close code. */
function accepts(message: unknown): boolean {
  return parseClientMessage(JSON.stringify(message)).ok;
}

describe("member.update", () => {
  it("accepts a media only update", () => {
    expect(accepts({ t: "member.update", micEnabled: false })).toBe(true);
    expect(accepts({ t: "member.update", cameraEnabled: false })).toBe(true);
  });

  it("accepts a translation preference update", () => {
    expect(accepts({ t: "member.update", wantsTranslation: false })).toBe(true);
  });

  it("accepts every field at once", () => {
    expect(
      accepts({
        t: "member.update",
        username: "Ana",
        dialect: "es-AR",
        micEnabled: true,
        cameraEnabled: false,
        wantsTranslation: false,
      }),
    ).toBe(true);
  });

  it("rejects a non boolean flag", () => {
    expect(accepts({ t: "member.update", micEnabled: "no" })).toBe(false);
    expect(accepts({ t: "member.update", wantsTranslation: 1 })).toBe(false);
  });

  // The existing shapes have to keep working: this message predates the new fields and the
  // dialect picker still sends the dialect only form.
  it("still accepts the username only and dialect only forms", () => {
    expect(accepts({ t: "member.update", username: "Ana" })).toBe(true);
    expect(accepts({ t: "member.update", dialect: "es-AR" })).toBe(true);
    expect(accepts({ t: "member.update" })).toBe(true);
  });

  it("still rejects an unknown dialect", () => {
    expect(accepts({ t: "member.update", dialect: "xx-YY" })).toBe(false);
  });
});

// The server sends CODES for anything a user reads, never prose. The client owns every word on
// screen, so it can render them in the reader's own language. These schemas are what keeps the
// two lists from drifting: a code the server invents and the client has no copy for is a blank
// space where an explanation should be.
describe("user facing codes", () => {
  it("accepts every error code it publishes", () => {
    for (const code of ERROR_CODES) {
      expect(errorCode.safeParse(code).success).toBe(true);
    }
  });

  it("refuses prose where an error code belongs", () => {
    expect(errorCode.safeParse("that chat already has two people in it").success).toBe(false);
  });

  it("accepts every translation failure code it publishes", () => {
    for (const code of TRANSLATION_FAILURE_CODES) {
      expect(translationFailureCode.safeParse(code).success).toBe(true);
    }
  });

  it("refuses prose where a translation failure code belongs", () => {
    expect(translationFailureCode.safeParse("translating too fast, catching up").success).toBe(
      false,
    );
  });

  it("keeps the exported arrays and the schemas as one list", () => {
    expect([...errorCode.options]).toEqual([...ERROR_CODES]);
    expect([...translationFailureCode.options]).toEqual([...TRANSLATION_FAILURE_CODES]);
  });
});

// A correction is a TERM (owner decision C1, 2026-10-09): the phrase from the line and its fix.
// The phrase is optional on the wire so a tab loaded before this change still corrects, as a whole
// line; the server then refuses a line too long to be a term.
describe("glossary.correct", () => {
  it("accepts a phrase and its fix", () => {
    expect(accepts({ t: "glossary.correct", lineId: "L1", source: "che", correctedTranslation: "hey" })).toBe(true);
  });

  it("still accepts the older form with no phrase", () => {
    expect(accepts({ t: "glossary.correct", lineId: "L1", correctedTranslation: "hey" })).toBe(true);
  });

  it("refuses an empty fix, or one that is only whitespace or control characters", () => {
    expect(accepts({ t: "glossary.correct", lineId: "L1", correctedTranslation: "" })).toBe(false);
    expect(accepts({ t: "glossary.correct", lineId: "L1", correctedTranslation: " \u0007 " })).toBe(false);
  });

  it("refuses an empty phrase", () => {
    expect(accepts({ t: "glossary.correct", lineId: "L1", source: "  ", correctedTranslation: "hey" })).toBe(false);
  });

  it("holds the phrase to a glossary term's length and the fix to a translation's", () => {
    const base = { t: "glossary.correct", lineId: "L1" };
    expect(accepts({ ...base, source: "a".repeat(200), correctedTranslation: "b".repeat(400) })).toBe(true);
    expect(accepts({ ...base, source: "a".repeat(201), correctedTranslation: "b" })).toBe(false);
    expect(accepts({ ...base, source: "a", correctedTranslation: "b".repeat(401) })).toBe(false);
  });
});
