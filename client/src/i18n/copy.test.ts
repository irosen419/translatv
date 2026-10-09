// What this suite is actually guarding.
//
// The completeness of the files is script/check_copy.mjs's job, and it runs in `npm run check`.
// These tests cover the two things a completeness check cannot see: that the fallback chain
// picks the right file, and that the dialect overrides say what the DIALECTS catalog says they
// must. A file can be complete and still put tu in front of an Argentine.

import { describe, expect, it, vi } from "vitest";

import { copyFor, interpolate, type CopyRef } from "./copy.js";
import esAR from "./es-AR.json";
import esCO from "./es-CO.json";
import esES from "./es-ES.json";

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
    expect(copyFor("en-US").t("correct.problem.fixTooLong", { max: 400 })).toContain("400");
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

/**
 * Keys whose "vuelve" is the third person ("la llamada vuelve a conectarse", or usted in es-CO),
 * which is right in these registers. None today. Anywhere else here, "vuelve" is the tú
 * imperative ("vuelve a intentarlo", "vuelve al inicio", "vuelve más tarde"). Two slips only this
 * sweep sees read it in the wrong register: a new base line with no regional override, and an
 * override edited back to it. Both went green with no sweep, and a new "vuelve al inicio" or
 * "vuelve más tarde" line went green with a sweep for "vuelve a" alone (measured in review). A
 * correct third person line fails it until its key is listed here, which is the decision a reviewer
 * should see, and the failure says so.
 */
const THIRD_PERSON_VUELVE = new Set<string>([]);

function vuelveSweep(dialect: string): void {
  const found: string[] = [];
  for (const [key, text] of copyFor(dialect).all()) {
    if (key.startsWith(QUOTES_OTHER_DIALECTS) || THIRD_PERSON_VUELVE.has(key)) continue;
    if (words(text).includes("vuelve")) found.push(key);
  }
  expect(found, "a third person vuelve is right: list its key in THIRD_PERSON_VUELVE").toEqual([]);
}

/**
 * Every override each regional file carries, by name.
 *
 * A regional file that loses an override reads that line in base Spanish, which addresses the
 * reader as tú. No word list catches that in general: the tú imperative is spelled like the third
 * person ("vuelve a", "intenta"), so a phrase sweep flagged correct lines, and 63 of the 143
 * overrides in es-AR and es-CO could be deleted with every other check green, almost all of them
 * putting tú in front of someone who reads vos or usted (review deleted each in turn). So losing
 * one fails here, by its key. Adding one needs no change; removing one on purpose means removing
 * its name, which is the decision a reviewer should see.
 */
const PINNED_OVERRIDES: Record<string, string[]> = {
  "es-AR": [
    "account.delete.expired", "account.delete.password", "account.invite.failed",
    "account.invite.lead", "app.ended.left.host", "auth.displayName.hint",
    "auth.error.EMAIL_TAKEN", "auth.error.INVALID_INPUT", "auth.error.LOCKED",
    "auth.error.RATE_LIMITED", "auth.error.WEAK_PASSWORD", "auth.error.unavailable",
    "auth.invite.hint", "auth.sub", "auth.switch.toSignIn", "auth.switch.toSignUp",
    "chips.cloud.title", "chips.onDevice.title", "composer.placeholder", "error.ALREADY_IN_ROOM",
    "error.HOST_NOT_PRESENT", "error.INVALID_RESUME", "error.MALFORMED", "error.NOT_IN_ROOM",
    "error.PAYLOAD_TOO_LARGE", "error.RATE_LIMITED", "error.ROOM_NOT_FOUND",
    "error.UNAUTHENTICATED", "failure.EMPTY_RESULT", "failure.PROVIDER_ERROR",
    "failure.PROVIDER_RATE_LIMITED", "failure.TIMED_OUT", "failure.TOO_MANY_IN_FLIGHT",
    "failure.UNRESOLVED_DIALECT", "landing.codeHint", "media.denied.camera",
    "media.denied.microphone", "media.inUse.camera", "media.inUse.microphone",
    "media.insecure.camera", "media.insecure.microphone", "media.noDevice.camera",
    "media.noDevice.microphone", "overlay.empty", "overlay.you", "panel.empty",
    "prejoin.title.create", "room.camera.offLabel", "room.camera.onLabel", "room.dialect.title",
    "room.end.alt.before", "room.end.body", "room.end.host.note", "room.invite.lead",
    "room.mic.muteLabel", "room.mic.unmuteLabel", "room.translation.title", "room.you",
    "stt.keepsDropping", "stt.noMicrophone", "stt.permission",
    // The corrections pull request: the term dialog and the saved list, in voseo.
    "correct.body", "correct.phrase.hint", "correct.problem.empty", "correct.problem.fixTooLong",
    "correct.problem.notInLine", "correct.problem.phraseTooLong", "saved.deleteFailed",
    "saved.empty", "saved.lead", "saved.loadFailed",
  ],
  "es-CO": [
    "account.delete.expired", "account.delete.lead", "account.delete.password",
    "account.delete.title", "account.invite.failed", "account.invite.lead", "app.ended.left",
    "app.ended.left.host", "auth.displayName", "auth.displayName.hint", "auth.error.EMAIL_TAKEN",
    "auth.error.INVALID_INPUT", "auth.error.LOCKED", "auth.error.RATE_LIMITED",
    "auth.error.WEAK_PASSWORD", "auth.error.unavailable", "auth.invite.hint", "auth.sub",
    "auth.switch.toSignIn", "auth.switch.toSignUp", "chips.cloud.title", "chips.onDevice.title",
    "chips.translationOff.title", "composer.placeholder", "correct.body",
    "error.ALREADY_IN_ROOM", "error.HOST_NOT_PRESENT", "error.INVALID_RESUME", "error.MALFORMED",
    "error.NOT_IN_ROOM", "error.PAYLOAD_TOO_LARGE", "error.RATE_LIMITED", "error.ROOM_NOT_FOUND",
    "error.UNAUTHENTICATED", "failure.EMPTY_RESULT", "failure.PROVIDER_ERROR",
    "failure.PROVIDER_RATE_LIMITED", "failure.TIMED_OUT", "failure.TOO_MANY_IN_FLIGHT",
    "failure.UNRESOLVED_DIALECT", "landing.codeHint", "media.denied.camera",
    "media.denied.microphone", "media.inUse.camera", "media.inUse.microphone",
    "media.insecure.camera", "media.insecure.microphone", "media.noDevice.camera",
    "media.noDevice.microphone", "media.other.camera", "media.other.microphone", "overlay.you",
    "panel.empty", "prejoin.dialect.label", "prejoin.name.label", "prejoin.stt.cloud",
    "prejoin.stt.onDevice", "prejoin.sub.create", "prejoin.title.create", "room.camera.offLabel",
    "room.camera.onLabel", "room.dialect.label", "room.dialect.title", "room.end.alt.before",
    "room.end.body", "room.end.host.note", "room.invite.lead", "room.mic.level",
    "room.mic.muteLabel", "room.mic.unmuteLabel", "room.translation.title", "room.you",
    "stt.keepsDropping", "stt.noMicrophone", "stt.permission",
    // The corrections pull request: the term dialog and the saved list, in usted.
    "correct.phrase.hint", "correct.problem.empty", "correct.problem.fixTooLong",
    "correct.problem.notInLine", "correct.problem.phraseTooLong", "saved.deleteFailed",
    "saved.empty", "saved.lead", "saved.loadFailed", "saved.title",
  ],
  "es-ES": [
    "account.delete.changed", "landing.sub", "overlay.empty", "prejoin.stt.cloud",
    "room.translation.mootTitle",
  ],
};
const REGIONAL_FILES: Record<string, Record<string, string>> = { "es-AR": esAR, "es-CO": esCO, "es-ES": esES };

describe("every regional override", () => {
  it.each(Object.keys(PINNED_OVERRIDES))("is still in %s", (dialect) => {
    const present = new Set(Object.keys(REGIONAL_FILES[dialect] ?? {}));
    expect(PINNED_OVERRIDES[dialect]?.filter((key) => !present.has(key))).toEqual([]);
  });
});

describe("Argentine Spanish (es-AR)", () => {
  const copy = copyFor("es-AR");

  it("uses voseo for a second person imperative", () => {
    expect(copy.t("composer.placeholder")).toContain("Escribí");
    expect(copy.t("panel.empty")).toContain("Decí");
    expect(copy.t("room.dialect.title")).toContain("Cambiá");
    // Pinned by key as well as swept: the sweep below says what this line must not say, and this
    // says what it says instead.
    expect(copy.t("account.delete.expired")).toContain("Volvé");
  });

  it("uses vos rather than tu for the subject pronoun", () => {
    expect(copy.t("room.you")).toBe("Vos");
    expect(copy.t("overlay.you")).toBe("vos");
  });

  // The catalog's instruction, verbatim: NEVER use tu or tienes or puedes.
  it("never addresses the reader as tu", () => {
    sweep("es-AR", ["tú", "tienes", "puedes", "quieres", "eres", "vienes"]);
  });

  it("says volvé, never the tú imperative vuelve", () => {
    vuelveSweep("es-AR");
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
    expect(copy.t("account.delete.expired")).toContain("Vuelva");
  });

  it("never addresses the reader as tu or vos", () => {
    // "tu" too: the possessive of tú. Usted's is "su", and a key es-CO forgets to override
    // inherits base Spanish's "tu" (review reverted an es-CO override with every gate green).
    sweep("es-CO", ["tú", "tu", "vos", "tienes", "puedes", "tenés", "quieres", "escribe", "recarga"]);
  });

  it("says vuelva, never the tú imperative vuelve", () => {
    vuelveSweep("es-CO");
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

// The sign in and sign up screens arrived with accounts (M4) and address the reader on almost
// every line, which is exactly where a register slip would show. The sweeps above already cover
// them; these pin one line per dialect so a revert to base Spanish fails by name.
describe("the account screens speak each dialect's register", () => {
  it("uses voseo in Argentina", () => {
    expect(copyFor("es-AR").t("auth.sub")).toContain("Necesitás");
    expect(copyFor("es-AR").t("auth.switch.toSignUp")).toContain("tenés");
  });

  it("uses usted in Colombia", () => {
    expect(copyFor("es-CO").t("auth.sub")).toContain("Necesita una cuenta");
    expect(copyFor("es-CO").t("auth.displayName")).toBe("Su nombre");
  });

  it("uses tu in base Spanish, which is also Spain's singular", () => {
    expect(copyFor("es").t("auth.sub")).toContain("Necesitas");
    expect(copyFor("es-ES").t("auth.sub")).toBe(copyFor("es").t("auth.sub"));
  });

  it("asks for the password to delete an account in each register", () => {
    expect(copyFor("es").t("account.delete.password")).toContain("Escribe tu contraseña");
    expect(copyFor("es-AR").t("account.delete.password")).toContain("Escribí tu contraseña");
    expect(copyFor("es-CO").t("account.delete.password")).toContain("Escriba su contraseña");
    expect(copyFor("es-CO").t("account.delete.lead")).toContain("su cuenta");
  });

  it("keeps the password minimum as a placeholder in every language", () => {
    for (const dialect of ["en-US", "es", "es-AR", "es-CO", "es-ES"]) {
      expect(copyFor(dialect).t("auth.error.WEAK_PASSWORD", { min: 10 })).toContain("10");
    }
  });
});
