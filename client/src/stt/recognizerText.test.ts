import { describe, expect, it } from "vitest";

import { cleanRecognizerText } from "./recognizerText.js";

describe("cleanRecognizerText", () => {
  it("drops the sentence markers a recognizer leaks into its text", () => {
    // Seen from Chrome's cloud path in an owner test (2026-11-13): "Scooby-Doo </S>".
    expect(cleanRecognizerText("Scooby-Doo </S>")).toBe("Scooby-Doo");
    expect(cleanRecognizerText("<s> hola </s>")).toBe("hola");
    expect(cleanRecognizerText("a <unk> word")).toBe("a word");
  });

  it("leaves everything else alone, angle brackets included", () => {
    expect(cleanRecognizerText("x < y and y > z")).toBe("x < y and y > z");
    expect(cleanRecognizerText("the <span> tag")).toBe("the <span> tag");
    expect(cleanRecognizerText("qué hacés, che")).toBe("qué hacés, che");
  });

  it("leaves nothing when the result was only a marker", () => {
    expect(cleanRecognizerText(" </s> ")).toBe("");
  });
});
