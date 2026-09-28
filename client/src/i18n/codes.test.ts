// Every code the server can send has a sentence, in each base language, at runtime.
//
// codes.ts makes a code with no English key a TYPE error. That is the compile time half. This is
// the runtime half, for what the type check cannot see: a code whose Spanish sentence is missing,
// and one that resolves to the "copy is missing" placeholder rather than to words.
//
// A missing Spanish key does NOT resolve to the placeholder: lookup falls back to English, so a
// Spanish speaker is quietly handed the English sentence. That is why the Spanish sentence is
// also required to differ from the English one. (check:copy reports the missing key as well; this
// holds the same line for exactly the keys the wire can reach.) USER_CAP (docs/PLAN.md, D10), the
// newest code, is covered by the same loops as every other code rather than by its own wording.

import { ERROR_CODES, TRANSLATION_FAILURE_CODES } from "@translatv/shared";
import { describe, expect, it } from "vitest";

import { errorCopyKey, failureCopyKey } from "./codes.js";
import { copyFor } from "./copy.js";

const ENGLISH = "en-US";
const SPANISH = "es-MX";

describe("wire codes to copy", () => {
  /** The sentence for key in each base language, checked for words and for real Spanish. */
  function expectBothLanguages(key: Parameters<ReturnType<typeof copyFor>["t"]>[0], label: string): void {
    const english = copyFor(ENGLISH);
    const spanish = copyFor(SPANISH);
    expect(english.t(key), `${ENGLISH} ${label}`).not.toBe(english.t("copy.missing"));
    expect(spanish.t(key), `${SPANISH} ${label}`).not.toBe(spanish.t("copy.missing"));
    // The fallback case: with its es.json key gone, the Spanish sentence IS the English one.
    expect(spanish.t(key), `${SPANISH} ${label} is the English sentence`).not.toBe(english.t(key));
  }

  it("gives every translation failure code a sentence in each base language", () => {
    for (const code of TRANSLATION_FAILURE_CODES) expectBothLanguages(failureCopyKey(code), code);
  });

  it("gives every error code a sentence in each base language", () => {
    for (const code of ERROR_CODES) expectBothLanguages(errorCopyKey(code), code);
  });
});
