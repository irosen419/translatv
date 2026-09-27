import { describe, expect, it } from "vitest";
import type { RenderedLine } from "@translatv/shared";
import { captionFor, liveCaptionFor } from "./caption.js";

function line(over: Partial<RenderedLine> = {}): RenderedLine {
  return {
    lineId: "l1",
    from: "m1",
    text: "hola",
    srcDialect: "es-AR",
    ts: "2026-07-31T00:00:00.000Z",
    source: "speech",
    translated: "hello",
    translationStatus: "ok",
    revision: 1,
    skipReason: null,
    ...over,
  } as RenderedLine;
}

// The fixture is a Spanish line translated to English. Read by EN, it is the peer talking;
// read by ES, it is your own line coming back. Those are the two cases this whole file turns on.
const EN = "en-US";
const ES = "es-AR";

describe("captionFor", () => {
  it("puts the translation on top and the original beneath", () => {
    expect(captionFor(line(), EN)).toEqual({
      primary: "hello",
      secondary: "hola",
      untranslated: false,
      pendingRow: null,
      noteKey: null,
    });
  });

  it("shows an ellipsis while the translation is in flight", () => {
    const caption = captionFor(line({ translated: null, translationStatus: "pending" }), EN);
    expect(caption.primary).toBe("...");
    expect(caption.secondary).toBe("hola");
    expect(caption.pendingRow).toBe("primary");
  });

  // The reader's own language goes on top, whoever spoke. The rows are the same two strings
  // either way: which one is PROMINENT is the only thing that moves, and it moves per reader.
  // Before this, both people saw the same arrangement, so exactly one of them was reading their
  // own sentence as the small italic afterthought under a translation they cannot check.
  describe("the reader's own language takes the prominent row", () => {
    it("promotes your own words when you are the one who spoke", () => {
      expect(captionFor(line(), ES)).toEqual({
        primary: "hola",
        secondary: "hello",
        untranslated: false,
        pendingRow: null,
        noteKey: null,
      });
    });

    it("keeps your own words up while their translation is still in flight", () => {
      // Your sentence is known the moment you say it. Only the outgoing translation is pending,
      // so the ellipsis belongs on the quiet row, not over the words you just spoke.
      const caption = captionFor(line({ translated: null, translationStatus: "pending" }), ES);
      expect(caption.primary).toBe("hola");
      expect(caption.secondary).toBe("...");
      // The row waiting on the model is the QUIET one here, so the reader's own words must not
      // pick up the muted pending styling both overlays hang off this field.
      expect(caption.pendingRow).toBe("secondary");
    });

    it("compares by language and not by exact dialect code", () => {
      // Switching your own dialect mid call leaves your earlier lines tagged with the old code.
      // They are still your words in your language and must not demote themselves behind you.
      expect(captionFor(line({ srcDialect: "es-AR" }), "es-MX").primary).toBe("hola");
    });

    it("falls back to the translation when the speaker's dialect cannot be resolved", () => {
      // Honesty rule, same as translationNeed: an unresolvable code has no answer, so it must
      // not be ASSERTED to be the reader's language. Guessing wrong here buries the one row the
      // reader can actually read.
      expect(captionFor(line({ srcDialect: "zz-ZZ" }), EN).primary).toBe("hello");
      expect(captionFor(line({ srcDialect: "zz-ZZ" }), ES).primary).toBe("hello");
    });

    it("falls back to the translation when the reader's own dialect is unknown", () => {
      expect(captionFor(line(), null).primary).toBe("hello");
    });
  });

  it("promotes the words themselves when nothing needed translating", () => {
    // Skipped is not a failure, so the words take the prominent row and nothing is marked. The
    // normal path would leave the big row blank with the text stranded in the small italic one.
    expect(
      captionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: "same_language" }),
        EN,
      ),
    ).toEqual({
      primary: "hola",
      secondary: "",
      untranslated: false,
      pendingRow: null,
      // Silent, and only for this reason. Two people who share a language do not need telling
      // that their own sentence was not translated into their own language.
      noteKey: null,
    });
  });

  // Three situations used to render identically: the same words, large, with nothing to
  // distinguish them. Only one of the three is genuinely nothing worth saying.
  describe("a skipped line says which kind of skip it was", () => {
    it("explains a reader who turned translation off", () => {
      const caption = captionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: "recipient_off" }),
        EN,
      );
      expect(caption.primary).toBe("hola");
      expect(caption.noteKey).toBe("caption.translationOff");
      // A NOTE, not a marker. Nothing failed, so it must not borrow the failure styling or the
      // retry button that goes with it.
      expect(caption.untranslated).toBe(false);
    });

    it("explains an empty room", () => {
      const caption = captionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: "no_peer" }),
        EN,
      );
      expect(caption.noteKey).toBe("caption.nobodyHere");
      expect(caption.untranslated).toBe(false);
    });

    it("stays silent when both people share a language", () => {
      const caption = captionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: "same_language" }),
        EN,
      );
      expect(caption.noteKey).toBe(null);
    });

    it("says nothing rather than guessing when the reason did not survive", () => {
      // A line skipped by a server that predates the field, or any other gap. Silence is the
      // honest answer: inventing one of the three reasons here would be the original bug with
      // more confidence.
      const caption = captionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: null }),
        EN,
      );
      expect(caption.noteKey).toBe(null);
      expect(caption.primary).toBe("hola");
    });
  });

  it("has no note on a line that was translated", () => {
    expect(captionFor(line(), EN).noteKey).toBe(null);
  });

  it("has no note on a failure, which already has a marker", () => {
    expect(
      captionFor(line({ translated: "hola", translationStatus: "unavailable" }), EN).noteKey,
    ).toBe(null);
  });

  for (const status of ["unavailable", "rate_limited", "budget_exceeded"] as const) {
    it(`marks a ${status} line as untranslated without printing its text twice`, () => {
      // translated: line.text is the shape a failure ACTUALLY has at runtime. Both
      // RoomSession.setFailed and the client's translation.failed handler copy the original into
      // translated, deliberately, so the screen never goes blank. This fixture used to pass
      // null, which no path in the app can produce, and that is exactly why the suite could not
      // see the overlay rendering the same sentence large and then again small italic beneath.
      const caption = captionFor(line({ translated: "hola", translationStatus: status }), EN);
      expect(caption.untranslated).toBe(true);
      expect(caption.primary).toBe("hola");
      expect(caption.secondary).toBe("");
    });
  }

  it("drops the quiet row whenever it would only repeat the row above", () => {
    // The contract this interface documents, stated once for any status rather than only for
    // the failure path that happens to reach it today. A translation that comes back identical
    // to the original hits the same rule.
    const caption = captionFor(line({ translated: "hola", translationStatus: "ok" }), EN);
    expect(caption.primary).toBe("hola");
    expect(caption.secondary).toBe("");
  });

  it("has nothing to say about a missing line", () => {
    expect(captionFor(null, EN)).toEqual({
      primary: "",
      secondary: "",
      untranslated: false,
      pendingRow: null,
      noteKey: null,
    });
  });
});

describe("liveCaptionFor", () => {
  // An interim is speech that has NOT been finalized yet, so it is strictly newer than the
  // settled line beside it. Stacking the two put a translation of the PREVIOUS sentence directly
  // above the words of the current one, which reads as a translation of them and is not one.
  it("drops the previous sentence while new words are still being spoken", () => {
    const caption = liveCaptionFor(line(), "and then I said", EN);
    expect(caption.primary).toBe("");
    expect(caption.secondary).toBe("");
  });

  it("keeps nothing from the old line, not even its failure marker", () => {
    // The marker and the retry it implies belong to the sentence that failed. Left standing over
    // live words they accuse the wrong sentence.
    const caption = liveCaptionFor(
      line({ translated: "hola", translationStatus: "unavailable" }),
      "and then I said",
      EN,
    );
    expect(caption.untranslated).toBe(false);
    expect(caption.primary).toBe("");
  });

  // TWO fixtures, not one, and that is the point. No single line populates every field of a
  // caption: a skipped line carries a note but never a pending row, and a pending line carries a
  // row but never a note. Asserting the whole object against only the skipped one still passed a
  // version that leaked pendingRow through, which is half the reason this exists.
  const EMPTY_CAPTION = {
    primary: "",
    secondary: "",
    untranslated: false,
    pendingRow: null,
    noteKey: null,
  };

  it("keeps nothing from a skipped line, including its note", () => {
    expect(
      liveCaptionFor(
        line({ translated: null, translationStatus: "skipped", skipReason: "no_peer" }),
        "and then I said",
        EN,
      ),
    ).toEqual(EMPTY_CAPTION);
  });

  it("keeps nothing from a pending line, including its pending row", () => {
    // Without this, an implementation that blanked the texts and the note but left pendingRow
    // standing renders the muted still loading styling over words that are already final.
    expect(
      liveCaptionFor(
        line({ translated: null, translationStatus: "pending" }),
        "and then I said",
        EN,
      ),
    ).toEqual(EMPTY_CAPTION);
  });

  it("shows the settled caption again as soon as the sentence lands", () => {
    expect(liveCaptionFor(line(), "", EN)).toEqual(captionFor(line(), EN));
  });

  it("arranges that settled caption for the reader like any other", () => {
    expect(liveCaptionFor(line(), "", ES).primary).toBe("hola");
  });

  it("has nothing to say when there is no line and nobody talking", () => {
    expect(liveCaptionFor(null, "", EN)).toEqual({
      primary: "",
      secondary: "",
      untranslated: false,
      pendingRow: null,
      noteKey: null,
    });
  });
});
