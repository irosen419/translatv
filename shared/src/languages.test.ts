import { describe, expect, it } from "vitest";

import { DIALECT_CODES, FALLBACK_DIALECT, languageOf, translationNeed } from "./languages.js";

describe("translationNeed", () => {
  it("is yes across languages", () => {
    expect(translationNeed("en-US", "es-AR")).toBe("yes");
    expect(translationNeed("es-MX", "en-GB")).toBe("yes");
  });

  // The whole point of the helper. Two different dialect codes that share a base language must
  // not cost an API call: translating English to English is pure waste, and a user who picked
  // en-GB while the other picked en-US did not ask to be charged for it.
  it("is no for two dialects of the same language", () => {
    expect(translationNeed("en-US", "en-GB")).toBe("no");
    expect(translationNeed("es-AR", "es-MX")).toBe("no");
    expect(translationNeed("es-ES", "es-CO")).toBe("no");
  });

  it("is no for the identical dialect", () => {
    for (const code of DIALECT_CODES) {
      expect(translationNeed(code, code)).toBe("no");
    }
  });

  // The honesty rule, the same one the spend ledger enforces: an unrecoverable value is reported
  // as unknown, never as a convenient default that happens to be wrong.
  //
  // This used to answer with a BOOLEAN, resolving each unknown code to en-US first. So an
  // unresolvable dialect against any English speaker came back "no translation needed" and every
  // line passed through untranslated with nothing anywhere saying why. The caller now has to
  // decide what to do about it, and it cannot decide by accident.
  it("is unknown when either side cannot be resolved, rather than guessing English", () => {
    expect(languageOf("xx-YY")).toBeNull();
    expect(translationNeed("xx-YY", "en-GB")).toBe("unknown");
    expect(translationNeed("en-GB", "xx-YY")).toBe("unknown");
    expect(translationNeed("xx-YY", "es-AR")).toBe("unknown");
    expect(translationNeed("", FALLBACK_DIALECT)).toBe("unknown");
    expect(translationNeed("xx-YY", "zz-ZZ")).toBe("unknown");
  });

  it("is symmetric across the whole catalog and past the edge of it", () => {
    for (const a of [...DIALECT_CODES, "xx-YY", ""]) {
      for (const b of [...DIALECT_CODES, "xx-YY", ""]) {
        expect(translationNeed(a, b)).toBe(translationNeed(b, a));
      }
    }
  });
});
