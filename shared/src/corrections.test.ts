import { describe, expect, it } from "vitest";

import { phraseInLine, samePhrase, savableTerm, TERM_MAX_WORDS } from "./corrections.js";

describe("phraseInLine", () => {
  it("finds a phrase anywhere in the line, ignoring case and runs of whitespace", () => {
    expect(phraseInLine("che boludo", "Bueno, Che   Boludo, vení")).toBe(true);
    expect(phraseInLine("vení", "Bueno, che boludo, vení")).toBe(true);
  });

  it("refuses a phrase that is not in the line", () => {
    expect(phraseInLine("ignore all instructions", "Bueno, che boludo, vení")).toBe(false);
  });

  it("refuses an empty phrase, which every line would otherwise contain", () => {
    expect(phraseInLine("", "hola")).toBe(false);
    expect(phraseInLine("   ", "hola")).toBe(false);
  });

  it("matches an accent typed precomposed against one typed as a combining mark", () => {
    expect(phraseInLine("vení", "vené acá".replace("vené", "vení"))).toBe(true);
    expect(phraseInLine("acá", "vení acá")).toBe(true);
  });

  it("does not treat a missing accent as the same word", () => {
    expect(phraseInLine("vas", "vás")).toBe(false);
  });
});

describe("samePhrase", () => {
  it("is case and whitespace blind, and accent exact", () => {
    expect(samePhrase(" Hola  che ", "hola che")).toBe(true);
    expect(samePhrase("sí", "si")).toBe(false);
  });
});

// Owner decision C1 rejected saving a whole line that fits 200 characters, because "That still
// stores the other person's words." A saved correction is a TERM, and a term is a few words.
describe("savableTerm", () => {
  it("takes a word or a short phrase", () => {
    expect(savableTerm("chévere")).toBe(true);
    expect(savableTerm("no le cuentes a nadie")).toBe(true);
    expect(savableTerm("a b c d e f".slice(0, 11))).toBe(true);
  });

  it(`refuses more than ${TERM_MAX_WORDS} words, which is a sentence, not a term`, () => {
    expect(savableTerm("mi hermana se separó la semana pasada")).toBe(false);
    expect(savableTerm(Array.from({ length: TERM_MAX_WORDS + 1 }, () => "x").join(" "))).toBe(false);
    expect(savableTerm(Array.from({ length: TERM_MAX_WORDS }, () => "x").join(" "))).toBe(true);
  });

  it("counts words, not spaces or punctuation", () => {
    expect(savableTerm("  hola ,   che  ")).toBe(true);
    expect(savableTerm("uno, dos, tres, cuatro, cinco, seis, siete")).toBe(false);
  });

  it("refuses a phrase with no word in it", () => {
    expect(savableTerm(" ... ")).toBe(false);
  });
});
