// Every code the server can send has a sentence, in each base language, at runtime.
//
// codes.ts makes a code with no English key a TYPE error. That is the compile time half. This is
// the runtime half, and it exists for the code the type check cannot catch: one whose key is in
// en.json but whose Spanish sentence is missing, which check:copy also reports, and one that
// resolves to the "copy is missing" placeholder rather than to words. USER_CAP (docs/PLAN.md,
// D10) is named on its own below because it is the newest code and the one a reader is most
// likely to hit on an ordinary day.

import { ERROR_CODES, TRANSLATION_FAILURE_CODES } from "@translatv/shared";
import { describe, expect, it } from "vitest";

import { errorCopyKey, failureCopyKey } from "./codes.js";
import { copyFor } from "./copy.js";

const DIALECTS = ["en-US", "es-MX"] as const;

describe("wire codes to copy", () => {
  it("gives every translation failure code a sentence in each base language", () => {
    for (const dialect of DIALECTS) {
      const copy = copyFor(dialect);
      const missing = copy.t("copy.missing");
      for (const code of TRANSLATION_FAILURE_CODES) {
        expect(copy.t(failureCopyKey(code)), `${dialect} ${code}`).not.toBe(missing);
      }
    }
  });

  it("gives every error code a sentence in each base language", () => {
    for (const dialect of DIALECTS) {
      const copy = copyFor(dialect);
      const missing = copy.t("copy.missing");
      for (const code of ERROR_CODES) {
        expect(copy.t(errorCopyKey(code)), `${dialect} ${code}`).not.toBe(missing);
      }
    }
  });

  it("tells the reader the HOST's daily budget ran out, in their own language", () => {
    const english = copyFor("en-US").t(failureCopyKey("USER_CAP"));
    const spanish = copyFor("es-MX").t(failureCopyKey("USER_CAP"));
    expect(english).toMatch(/host/i);
    // "La persona que organiza", the phrasing HOST_NOT_PRESENT already uses: no tu or vos, so
    // no dialect has to override it.
    expect(spanish).toMatch(/organiza/i);
    expect(spanish).not.toBe(english);
  });
});
