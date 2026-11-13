import { describe, expect, it } from "vitest";
import type { RenderedLine } from "@translatv/shared";

import { looksUntranslated, speakingOtherLanguage } from "./languageMismatch.js";

function line(text: string, translated: string | null, overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    lineId: `L${Math.random()}`,
    from: "me",
    srcDialect: "es-AR",
    text,
    source: "speech",
    ts: "2026-11-13T00:00:00.000Z",
    translated,
    translationStatus: translated === null ? "pending" : "ok",
    revision: 1,
    skipReason: null,
    ...overrides,
  } as RenderedLine;
}

describe("looksUntranslated", () => {
  it("is true when the translation is nearly the line itself", () => {
    // From the owner's test: the phone was set to Spanish while he spoke English into it.
    expect(looksUntranslated("One in the chapter now we're at number two", "Una in the chapter now we're at number two")).toBe(true);
    expect(looksUntranslated("And a security scan tumor PRS", "And a security scan tumor PRS")).toBe(true);
  });

  it("is false for a real translation, and for lines too short to judge", () => {
    expect(looksUntranslated("Y entonces estaba en las paredes de la cocina", "And then he was in the kitchen walls")).toBe(false);
    expect(looksUntranslated("Okay", "Okay")).toBe(false);
    expect(looksUntranslated("Hola Ana", "Hola Ana")).toBe(false);
  });
});

describe("speakingOtherLanguage", () => {
  const english = (t: string) => line(t, t);
  const real = line("¿Tenés tiempo mañana a la tarde?", "Do you have time tomorrow afternoon?");

  it("is true once two of your last three translated lines came back unchanged", () => {
    expect(speakingOtherLanguage([english("so maybe on the security side"), english("we can have a spike in there")], "me")).toBe(true);
  });

  it("is false for one odd line, which a name or a quote can cause", () => {
    expect(speakingOtherLanguage([real, english("so maybe on the security side"), real], "me")).toBe(false);
  });

  it("only looks at your own lines", () => {
    const theirs = (t: string) => line(t, t, { from: "peer" });
    expect(speakingOtherLanguage([theirs("so maybe on the security side"), theirs("we can have a spike in there")], "me")).toBe(false);
  });

  it("clears once you speak the language you chose again", () => {
    const mismatch = [english("so maybe on the security side"), english("we can have a spike in there")];
    expect(speakingOtherLanguage([...mismatch, real, real], "me")).toBe(false);
  });

  it("ignores lines that were never translated, or were typed", () => {
    const skipped = line("so maybe on the security side", null, { translationStatus: "skipped" });
    const typed = line("this is a new message here", "this is a new message here", { source: "chat" });
    expect(speakingOtherLanguage([skipped, skipped, typed, typed], "me")).toBe(false);
  });
});
