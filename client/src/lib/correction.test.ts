import { describe, expect, it } from "vitest";
import { LIMITS, type RenderedLine } from "@translatv/shared";
import { canCorrect, correctionDraft, correctionMessage, correctionProblem, willBeSaved } from "./correction.js";

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    lineId: "L1",
    from: "peer",
    srcDialect: "es-AR",
    text: "qué hacés, che",
    source: "speech",
    ts: "2026-10-09T00:00:00.000Z",
    translated: "what's up, hey",
    translationStatus: "ok",
    revision: 1,
    skipReason: null,
    ...overrides,
  };
}

// Owner decision C2 (2026-10-09): the fix is for the translation you READ, which is the other
// person's line. Your own line is shown to you as you said it.
describe("canCorrect", () => {
  it("offers a fix on the other person's translated line", () => {
    expect(canCorrect(line(), "me")).toBe(true);
  });

  it("never on your own line", () => {
    expect(canCorrect(line({ from: "me" }), "me")).toBe(false);
  });

  it("never on a line with no translation to fix", () => {
    for (const status of ["pending", "skipped", "unavailable", "rate_limited", "budget_exceeded"] as const) {
      expect(canCorrect(line({ translationStatus: status }), "me"), status).toBe(false);
    }
  });

  it("not before this tab knows who it is, since every line could then be its own", () => {
    expect(canCorrect(line(), null)).toBe(false);
  });
});

// Owner decision C1: the dialog asks for the phrase and its fix, prefilled from the line.
describe("correctionDraft", () => {
  it("starts from the whole line and its translation, for the person to trim", () => {
    expect(correctionDraft(line())).toEqual({ phrase: "qué hacés, che", fix: "what's up, hey" });
  });

  it("starts the fix empty when there is no translation", () => {
    expect(correctionDraft(line({ translated: null })).fix).toBe("");
  });
});

describe("correctionProblem", () => {
  const text = "qué hacés, che";

  it("has nothing to say about a phrase from the line with a different fix", () => {
    expect(correctionProblem("che", "hey", text)).toBeNull();
    expect(correctionProblem("  Qué  hacés ", "what's up", text)).toBeNull();
  });

  it("asks for text in both fields", () => {
    expect(correctionProblem("", "hey", text)).toBe("correct.problem.empty");
    expect(correctionProblem("che", "   ", text)).toBe("correct.problem.empty");
  });

  it("names a phrase over a term's length and a fix over a translation's, and passes both at it", () => {
    const long = "a".repeat(LIMITS.glossaryTerm);
    expect(correctionProblem(`${long}a`, "b", `${long}a`)).toBe("correct.problem.phraseTooLong");
    expect(correctionProblem("che", "b".repeat(LIMITS.glossaryTranslation + 1), text)).toBe("correct.problem.fixTooLong");
    expect(correctionProblem(long, "b".repeat(LIMITS.glossaryTranslation), long)).toBeNull();
  });

  // The server refuses a phrase that is not in the line, and says nothing back. The dialog has to
  // say it first, or the save button would look like it did nothing.
  it("says when the phrase is not in what they said", () => {
    expect(correctionProblem("boludo", "dude", text)).toBe("correct.problem.notInLine");
  });

  it("says when the fix only repeats the phrase", () => {
    expect(correctionProblem("che", " CHE ", text)).toBe("correct.problem.same");
  });
});

describe("correctionMessage", () => {
  it("sends the phrase and the fix, trimmed", () => {
    expect(correctionMessage("L1", "  che ", " hey ")).toEqual({
      t: "glossary.correct",
      lineId: "L1",
      source: "che",
      correctedTranslation: "hey",
    });
  });
});

// The prefill is the whole line. Saved untouched, it would keep the other person's sentence, so the
// dialog says when a correction will fix this call only (review round 1).
describe("willBeSaved", () => {
  it("is true for a few words, the term a correction is meant to be", () => {
    expect(willBeSaved(" che boludo ")).toBe(true);
  });

  it("is false for the whole of a sentence, which the untouched prefill is", () => {
    expect(willBeSaved(correctionDraft(line({ text: "mi hermana se separó la semana pasada" })).phrase)).toBe(false);
  });
});
