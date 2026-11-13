import { describe, expect, it } from "vitest";
import type { RenderedLine } from "@translatv/shared";
import { captionFor, holdFor, holdMsFor, peerLinesFor, subtitleFor } from "./caption.js";

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

/** A line of `count` words. */
const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");

describe("holdMsFor", () => {
  // The reading time a settled subtitle gets. It used to be a flat 3 seconds whatever the
  // sentence, which is plenty for "yes" and not close to enough for a twenty word answer.
  //
  // Literal milliseconds throughout, never the module's own constants: an expectation computed
  // from the constants under test agrees with them whatever they are changed to, so it could not
  // catch the floor, the slope, or the ceiling moving.
  it("gives a short line the 3 seconds every line used to get", () => {
    expect(holdMsFor("hello there")).toBe(3_000);
    expect(holdMsFor(words(5))).toBe(3_000);
  });

  it("adds reading time per word once a line is past the floor", () => {
    expect(holdMsFor(words(6))).toBe(3_300);
    // The two figures the change was described with.
    expect(holdMsFor(words(10))).toBe(4_500);
    expect(holdMsFor(words(20))).toBe(7_500);
  });

  it("is never shorter for a longer line", () => {
    let previous = 0;
    for (let words = 0; words <= 60; words += 1) {
      const hold = holdMsFor(Array.from({ length: words }, () => "word").join(" "));
      expect(hold).toBeGreaterThanOrEqual(previous);
      previous = hold;
    }
  });

  it("stops growing at the ceiling, so a monologue does not sit over the video forever", () => {
    expect(holdMsFor(words(28))).toBe(9_900);
    expect(holdMsFor(words(29))).toBe(10_000);
    expect(holdMsFor(words(80))).toBe(10_000);
  });

  // Past the floor on purpose: below it every count gives the same 3 seconds, so stray spaces
  // counted as words would change nothing and the test could not see them.
  it("counts words, not the spaces between them", () => {
    expect(holdMsFor(`  ${words(10).replaceAll(" ", " \n  ")}  `)).toBe(4_500);
    expect(holdMsFor("")).toBe(3_000);
  });
});

describe("holdFor", () => {
  it("has no clock when there is no line to hold", () => {
    expect(holdFor(null, EN).key).toBeNull();
  });

  it("keys on what the line says, not on which object it is", () => {
    // Lines are derived afresh per render, so the same line arrives as a new object whenever
    // anything else in the transcript changes, including your own speech.
    expect(holdFor(line({}), EN).key).toBe(holdFor({ ...line({}) }, EN).key);
  });

  it("gives two lines that say the same thing their own clocks", () => {
    // "si", then "si" again, both "yes". Keyed on content alone, the second would arrive with the
    // key the first already expired under, and never be shown at all.
    expect(holdFor(line({ lineId: "a" }), EN).key).not.toBe(holdFor(line({ lineId: "b" }), EN).key);
  });

  it("restarts when a translation lands, a correction is made, or the line fails", () => {
    const base = holdFor(line({}), EN).key;
    expect(holdFor(line({ translated: "hello there" }), EN).key).not.toBe(base);
    expect(holdFor(line({ revision: 2 }), EN).key).not.toBe(base);
    expect(holdFor(line({ translationStatus: "unavailable" }), EN).key).not.toBe(base);
  });

  it("times the row the reader actually reads", () => {
    // One word of Spanish, twenty of English: the English reader reads the translation, the
    // Spanish reader the original, and each gets the time their own row needs.
    const long = line({ text: "si", translated: words(20) });
    expect(holdFor(long, EN).ms).toBe(7_500);
    expect(holdFor(long, ES).ms).toBe(3_000);
  });
});

describe("peerLinesFor", () => {
  const mine = (over: Partial<RenderedLine>) => line({ from: "me", ...over });

  it("finds the peer's newest line, and the newest one whose translation has landed", () => {
    const lines = [
      line({ lineId: "a" }),
      mine({ lineId: "b" }),
      line({ lineId: "c", translated: null, translationStatus: "pending" }),
      mine({ lineId: "d" }),
    ];
    const { newest, settled } = peerLinesFor(lines, "me");
    expect(newest?.lineId).toBe("c");
    expect(settled?.lineId).toBe("a");
  });

  it("treats a failed or skipped line as settled, since nothing more is coming for it", () => {
    const failed = peerLinesFor([line({ translationStatus: "unavailable" })], "me");
    expect(failed.settled?.lineId).toBe("l1");
    const skipped = peerLinesFor(
      [line({ translated: null, translationStatus: "skipped", skipReason: "same_language" })],
      "me",
    );
    expect(skipped.settled?.lineId).toBe("l1");
  });

  it("finds nothing when only you have spoken", () => {
    expect(peerLinesFor([mine({})], "me")).toEqual({ newest: null, settled: null });
  });

  // A retry sends a failed line back to pending, still carrying the text it failed with. Walking
  // past it to the line before brought a sentence the reader had already finished back on screen
  // for a full hold, in place of the one they had just asked to retry.
  it("does not walk past a line that settled once and is being retried", () => {
    const retried = line({ lineId: "b", translated: "hola", translationStatus: "pending" });
    const fresh = line({ lineId: "c", translated: null, translationStatus: "pending" });
    expect(peerLinesFor([line({ lineId: "a" }), retried], "me")).toEqual({
      newest: retried,
      settled: null,
    });
    expect(peerLinesFor([line({ lineId: "a" }), retried, fresh], "me").settled).toBeNull();
  });
});

describe("subtitleFor", () => {
  const settledLine = line({ lineId: "old" });
  const pendingLine = line({
    lineId: "new",
    text: "y despues",
    translated: null,
    translationStatus: "pending",
  });
  const view = (over: Partial<Parameters<typeof subtitleFor>[0]>) =>
    subtitleFor({
      newest: settledLine,
      settled: settledLine,
      heldExpired: false,
      interimText: "",
      viewerDialect: EN,
      previous: null,
      ...over,
    });

  it("shows a settled line as its two rows, with nothing live beneath", () => {
    const shown = view({});
    expect(shown.caption).toEqual(captionFor(settledLine, EN));
    expect(shown.captionShown).toBe(true);
    expect(shown.live).toBeNull();
    expect(shown.faded).toBe(false);
  });

  // The bug this exists for. The overlay used to blank the top row the moment the peer started
  // their next sentence, so in an ordinary back and forth a translation was on screen for the
  // fraction of a second between it landing and the next word, and often not at all.
  it("keeps the last translation up while the next sentence is being spoken", () => {
    const shown = view({ interimText: "and then I said" });
    expect(shown.captionShown).toBe(true);
    expect(shown.caption.primary).toBe("hello");
    expect(shown.live).toEqual({ text: "and then I said", pending: false });
  });

  // Why the old version blanked it: a translation of the PREVIOUS sentence stacked directly on
  // the live words of the current one reads as a translation of them, and is not one. Keeping
  // the line up is only safe because the pair stays a pair and the live words get their own row.
  it("keeps the held translation paired with its OWN original, never with the live words", () => {
    const shown = view({ interimText: "and then I said" });
    expect(shown.caption.secondary).toBe("hola");
    expect(shown.caption.secondary).not.toBe("and then I said");
  });

  it("keeps a failure marker on the sentence that failed, not on the one being spoken", () => {
    const failed = line({ lineId: "old", translated: "hola", translationStatus: "unavailable" });
    const shown = view({ newest: failed, settled: failed, interimText: "and then I said" });
    expect(shown.caption.untranslated).toBe(true);
    expect(shown.caption.primary).toBe("hola");
    expect(shown.live?.text).toBe("and then I said");
  });

  it("puts a finished sentence still waiting on its translation in the live row", () => {
    const shown = view({ newest: pendingLine });
    expect(shown.caption.primary).toBe("hello");
    expect(shown.live).toEqual({ text: "y despues", pending: true });
  });

  it("prefers the words being spoken now over a sentence that is only waiting", () => {
    const shown = view({ newest: pendingLine, interimText: "and then" });
    expect(shown.live).toEqual({ text: "and then", pending: false });
  });

  describe("once the reader has had time to read it", () => {
    it("hides the line but keeps it in place, so the live row does not jump", () => {
      const last = captionFor(settledLine, EN);
      const shown = view({ heldExpired: true, interimText: "and then I said", previous: last });
      expect(shown.captionShown).toBe(false);
      expect(shown.caption).toEqual(last);
      expect(shown.live?.text).toBe("and then I said");
      // The live words are still something to read, so the scrim stays.
      expect(shown.faded).toBe(false);
    });

    it("shows nothing at all when nobody is talking either", () => {
      const shown = view({ heldExpired: true });
      expect(shown.captionShown).toBe(false);
      expect(shown.live).toBeNull();
      expect(shown.faded).toBe(true);
    });

    // The flash. The held line expired while the next sentence was still waiting, so the block
    // was showing that sentence's ellipsis. When the peer then started talking, the hidden block
    // swapped in the EXPIRED line and faded that, putting a sentence the reader had already
    // finished back on screen, over the live words, for the length of the fade.
    it("fades out what was on screen, not a line that had already gone", () => {
      const waitingShown = captionFor(pendingLine, EN);
      const shown = view({
        newest: pendingLine,
        heldExpired: true,
        interimText: "and then",
        previous: waitingShown,
      });
      expect(shown.captionShown).toBe(false);
      expect(shown.caption).toEqual(waitingShown);
      expect(shown.caption.primary).not.toBe("hello");
    });

    it("keeps the top empty while the peer talks over a sentence still waiting", () => {
      const shown = view({ newest: pendingLine, heldExpired: true, interimText: "and then" });
      expect(shown.captionShown).toBe(false);
      expect(shown.live).toEqual({ text: "and then", pending: false });
    });

    it("falls back to the waiting sentence, ellipsis on top, when there is nothing to hold", () => {
      const shown = view({ newest: pendingLine, heldExpired: true });
      expect(shown.captionShown).toBe(true);
      expect(shown.caption).toEqual(captionFor(pendingLine, EN));
      expect(shown.live).toBeNull();
    });
  });

  it("shows the waiting sentence when the peer has never had a translation land", () => {
    const shown = view({ newest: pendingLine, settled: null });
    expect(shown.caption).toEqual(captionFor(pendingLine, EN));
    expect(shown.captionShown).toBe(true);
  });

  it("leaves the top empty while the very first sentence is still being spoken", () => {
    const shown = view({ newest: null, settled: null, interimText: "hello" });
    expect(shown.captionShown).toBe(false);
    expect(shown.caption).toEqual(captionFor(null, EN));
    expect(shown.live).toEqual({ text: "hello", pending: false });
  });

  it("has nothing to say when there is no line and nobody talking", () => {
    const shown = view({ newest: null, settled: null });
    expect(shown.caption).toEqual(captionFor(null, EN));
    expect(shown.captionShown).toBe(false);
    expect(shown.live).toBeNull();
    expect(shown.faded).toBe(true);
  });

  it("arranges the held caption for the reader like any other", () => {
    expect(view({ viewerDialect: ES }).caption.primary).toBe("hola");
  });
});
