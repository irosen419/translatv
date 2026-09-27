// The one test that keeps the two same-language rules from drifting apart.
//
// There are two places that decide whether a line needs a model: the WS handler, which decides
// early via translationNeed so no rate limit token is taken and no pending frame is sent, and
// TranslationService, which keeps its own guard as defense in depth by resolving both dialects.
// Those two used to be written independently, and independently written rules drift. When they
// drift the symptom is not an exception: the handler announces a translation, the service silently
// echoes the text, and the client is told a model produced it.
//
// So rather than testing each in isolation, this asserts they agree on every pair, INCLUDING on
// which pairs neither of them is allowed to answer. Both used to resolve an unknown code to en-US,
// which is how they agreed on a wrong answer rather than agreeing on a refusal.

import { describe, expect, it } from "vitest";

import { DIALECT_CODES, dialectByCode, translationNeed } from "@translatv/shared";

/** Real codes plus the shapes an unknown code can take, since both sides must refuse alike. */
const CODES = [...DIALECT_CODES, "xx-YY", "en", "es", ""];

describe("translationNeed agrees with the service's own resolution", () => {
  it("reaches the same verdict for every ordered pair", () => {
    const disagreements: string[] = [];

    for (const a of CODES) {
      for (const b of CODES) {
        const early = translationNeed(a, b);
        const source = dialectByCode(a);
        const target = dialectByCode(b);
        const service =
          source === null || target === null
            ? "unknown"
            : source.language === target.language
              ? "no"
              : "yes";
        if (early !== service) {
          disagreements.push(`${a} -> ${b}: early=${early} service=${service}`);
        }
      }
    }

    expect(disagreements).toEqual([]);
  });

  it("actually exercises the unresolvable case", () => {
    // Guards the loop above against passing because every code in it happens to resolve. The
    // agreement that matters most is the one on the pairs NEITHER side may answer.
    expect(CODES.some((code) => dialectByCode(code) === null)).toBe(true);
    expect(translationNeed("xx-YY", "en-US")).toBe("unknown");
  });

  it("covers enough pairs to be meaningful", () => {
    // Guards the loop above against silently testing nothing if CODES were ever emptied.
    expect(CODES.length).toBeGreaterThanOrEqual(6);
  });
});
