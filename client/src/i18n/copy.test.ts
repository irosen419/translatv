// What this suite is actually guarding.
//
// The completeness of the files is script/check_copy.mjs's job, and it runs in `npm run check`.
// These tests cover the two things a completeness check cannot see: that the fallback chain
// picks the right file, and that the dialect overrides say what the DIALECTS catalog says they
// must. A file can be complete and still put tu in front of an Argentine.

import { describe, expect, it, vi } from "vitest";

import { copyFor, interpolate, type CopyRef } from "./copy.js";

describe("the fallback chain", () => {
  it("uses the base language when the dialect has no override for a key", () => {
    // A key no override touches. Both Spanish dialects must land on the same base string.
    expect(copyFor("es-AR").t("landing.title")).toBe(copyFor("es-ES").t("landing.title"));
    expect(copyFor("es-AR").t("landing.title")).not.toBe(copyFor("en-US").t("landing.title"));
  });

  it("prefers an exact dialect override over the base language", () => {
    expect(copyFor("es-AR").t("composer.placeholder")).not.toBe(
      copyFor("es-MX").t("composer.placeholder"),
    );
  });

  it("falls back to English for a dialect it has never heard of", () => {
    expect(copyFor("de-CH").t("landing.title")).toBe(copyFor("en-US").t("landing.title"));
  });

  it("falls back to English for a language it has no file for", () => {
    // fr has a base language but no fr.json. The chain must not stop at a missing file.
    expect(copyFor("fr-FR").t("room.leave")).toBe(copyFor("en-US").t("room.leave"));
  });

  it("reports the dialect it resolved for, so a caller can key a memo on it", () => {
    expect(copyFor("es-AR").dialect).toBe("es-AR");
  });
});

describe("interpolation", () => {
  it("substitutes a named placeholder", () => {
    expect(copyFor("en-US").t("room.peer.cameraOff", { name: "Ben" })).toBe(
      "Ben turned their camera off",
    );
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(interpolate("{name} and {name}", { name: "Ana" }, "?")).toBe("Ana and Ana");
  });

  it("leaves text with no placeholders exactly as written", () => {
    expect(interpolate("no braces here", { name: "Ana" }, "?")).toBe("no braces here");
  });

  it("renders a number", () => {
    expect(copyFor("en-US").t("prejoin.glossary.loaded.many", { count: 4 })).toContain("4");
  });

  // The house rule from the spend ledger, applied to words: an unrecoverable value is reported
  // as unknown, never as a convenient default that happens to be wrong. A placeholder with no
  // value is not a name to be quietly dropped.
  it("renders a missing value as unknown rather than dropping it or leaving the brace", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const rendered = copyFor("en-US").t("room.peer.cameraOff", {});
    spy.mockRestore();

    expect(rendered).not.toContain("{name}");
    expect(rendered).toContain(copyFor("en-US").t("copy.unknown"));
  });

  it("says so out loud when a value is missing, so it is a bug report and not a shrug", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    copyFor("en-US").t("room.peer.cameraOff", {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("copy refs", () => {
  it("renders a ref made far away from the screen", () => {
    const ref: CopyRef = { key: "room.peer.noCamera", params: { name: "Ana" } };
    expect(copyFor("en-US").ref(ref)).toBe("Ana joined without a camera");
  });

  it("renders nothing for no ref, because there is nothing to say", () => {
    expect(copyFor("en-US").ref(null)).toBe("");
  });

  it("renders a ref in the reader's own dialect, not the one it was made in", () => {
    const ref: CopyRef = { key: "composer.placeholder" };
    expect(copyFor("es-AR").ref(ref)).toBe(copyFor("es-AR").t("composer.placeholder"));
  });
});

describe("a key that is missing everywhere", () => {
  // Unreachable through the type system: CopyKey is derived from en.json, so every key a caller
  // can name exists in English. This is the cast shaped hole, and what matters is that it is
  // honest about itself rather than printing a key at a person mid call.
  it("says the text is missing instead of printing the key or an empty string", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const copy = copyFor("es-AR");
    const rendered = copy.t("nope.not.a.key" as never);
    spy.mockRestore();

    expect(rendered).toBe(copy.t("copy.missing"));
    expect(rendered).not.toContain("nope.not.a.key");
    expect(rendered.length).toBeGreaterThan(0);
  });
});

// The registers below are quoted from the DIALECTS catalog in shared/src/languages.ts. They are
// the entire reason per dialect files exist: second person is where Spanish splits, and getting
// it wrong is the difference between sounding local and sounding like a textbook.
//
// The sweeps below split on Unicode LETTERS rather than using \b. JavaScript's \b is defined on
// ASCII word characters even under the u flag, so /\btú\b/ never matches "tú" at all: the
// boundary after the accented vowel cannot exist. A test that cannot fail is worse than no test,
// and this one is guarding the feature's whole reason for being.
function words(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}+/gu) ?? []);
}

/**
 * Keys that QUOTE a dialect other than the reader's, on purpose.
 *
 * The region hint on the prejoin screen exists to show a Spanish speaker what picking Argentina
 * rather than Spain will actually do, so it says "vos tenés" and "vosotros" in every language.
 * Those are citations, not the register the reader is being addressed in.
 */
const QUOTES_OTHER_DIALECTS = "prejoin.dialect.hint.";

function sweep(dialect: string, forbidden: string[]): void {
  const found: string[] = [];
  for (const [key, text] of copyFor(dialect).all()) {
    if (key.startsWith(QUOTES_OTHER_DIALECTS)) continue;
    for (const word of words(text)) {
      if (forbidden.includes(word)) found.push(`${key}: ${word}`);
    }
  }
  expect(found).toEqual([]);
}

describe("Argentine Spanish (es-AR)", () => {
  const copy = copyFor("es-AR");

  it("uses voseo for a second person imperative", () => {
    expect(copy.t("composer.placeholder")).toContain("Escribí");
    expect(copy.t("panel.empty")).toContain("Decí");
    expect(copy.t("room.dialect.title")).toContain("Cambiá");
  });

  it("uses vos rather than tu for the subject pronoun", () => {
    expect(copy.t("room.you")).toBe("Vos");
    expect(copy.t("overlay.you")).toBe("vos");
  });

  // The catalog's instruction, verbatim: NEVER use tu or tienes or puedes.
  it("never addresses the reader as tu", () => {
    sweep("es-AR", ["tú", "tienes", "puedes", "quieres", "eres", "vienes"]);
  });

  it("uses ustedes for plural you, never vosotros", () => {
    sweep("es-AR", ["vosotros", "vuestro", "vuestra", "vuestros", "vuestras", "habláis"]);
    expect(copy.t("landing.sub")).toMatch(/ustedes/i);
  });
});

describe("Peninsular Spanish (es-ES)", () => {
  const copy = copyFor("es-ES");

  it("uses vosotros for plural you", () => {
    expect(copy.t("landing.sub")).toMatch(/vosotros/i);
    expect(copy.t("overlay.empty")).toMatch(/digáis/i);
  });

  it("keeps tu for singular you, so it never drifts into voseo", () => {
    sweep("es-ES", ["vos", "tenés", "podés", "sos", "escribí", "decí"]);
  });

  it("never uses ustedes, which is the Latin American plural", () => {
    sweep("es-ES", ["ustedes"]);
  });
});

describe("Colombian Spanish (es-CO)", () => {
  const copy = copyFor("es-CO");

  it("uses usted even in familiar register", () => {
    expect(copy.t("room.you")).toBe("Usted");
    expect(copy.t("overlay.you")).toBe("usted");
    expect(copy.t("composer.placeholder")).toContain("Escriba");
    expect(copy.t("panel.empty")).toContain("Diga");
  });

  it("never addresses the reader as tu or vos", () => {
    sweep("es-CO", ["tú", "vos", "tienes", "puedes", "tenés", "quieres", "escribe", "recarga"]);
  });

  it("still uses ustedes for plural you, not vosotros", () => {
    sweep("es-CO", ["vosotros", "vuestro", "vuestra"]);
  });
});

describe("Mexican Spanish (es-MX)", () => {
  const copy = copyFor("es-MX");

  // There is no es-MX.json on purpose: base Spanish here is already tu plus ustedes, which is
  // the Mexican register. This asserts that decision rather than leaving it as a comment.
  it("reads entirely from base Spanish", () => {
    // Compared as raw templates rather than through t(), which would interpolate the
    // placeholders away and quietly compare two identical "(unknown)" strings instead.
    expect(copy.all()).toEqual(copyFor("es").all());
  });

  it("uses tu for singular you and ustedes for plural", () => {
    expect(copy.t("room.you")).toBe("Tú");
    expect(copy.t("composer.placeholder")).toContain("Escribe");
    expect(copy.t("landing.sub")).toMatch(/ustedes/i);
  });

  it("never uses vosotros or voseo", () => {
    sweep("es-MX", ["vosotros", "vuestro", "vos", "tenés", "escribí"]);
  });
});
