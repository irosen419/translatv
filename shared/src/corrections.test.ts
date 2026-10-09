import { describe, expect, it } from "vitest";

import { phraseInLine, samePhrase } from "./corrections.js";

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
