// What this suite is actually guarding.
//
// The completeness of the files is script/check_copy.mjs's job, and it runs in `npm run check`.
// These tests cover the three things a completeness check cannot see: that the fallback chain
// picks the right file, that the dialect overrides say what the DIALECTS catalog says they must,
// and that no key has outlived the screen that rendered it. A file can be complete and still put
// tu in front of an Argentine, and it can be complete and still be carrying dead words.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { DIALECT_CODES } from "@translatv/shared";

import { THEMES } from "../theme/palettes.js";
import { THEME_MODES } from "../theme/theme.js";
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
    "correct.body", "correct.notSaved", "correct.phrase.hint", "correct.problem.empty", "correct.problem.fixTooLong",
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
    "correct.notSaved", "correct.phrase.hint", "correct.problem.empty", "correct.problem.fixTooLong",
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

/**
 * The words on the theme controls, in every dialect a reader can pick.
 *
 * Appearance stopped being a fieldset with three radios and became a second select. The five
 * keys are the same five either way, which is the point: the ELEMENT changed and the vocabulary
 * did not. check_copy.mjs proves every file HAS every key and runs first; what it cannot see is
 * whether a key still resolves to prose for a reader in es-CO rather than to the placeholder,
 * and it has no opinion about the ORDER the modes are offered in.
 */
describe("the theme control labels", () => {
  const CONTROL_LABELS = ["room.theme.label", "room.theme.appearance"] as const;
  const MODE_LABELS = [
    "room.theme.mode.light",
    "room.theme.mode.dark",
    "room.theme.mode.system",
  ] as const;
  const KEYS = [...CONTROL_LABELS, ...MODE_LABELS];

  // Every dialect the picker offers, plus one the app has never heard of, which lands on English.
  const READERS = [...DIALECT_CODES, "de-CH"];

  it("finds the dialects it sweeps, so a catalog move cannot silently empty this test", () => {
    expect(READERS.length).toBeGreaterThan(4);
  });

  for (const dialect of READERS) {
    it(`says all five out loud for ${dialect}`, () => {
      const copy = copyFor(dialect);
      for (const key of KEYS) {
        const text = copy.t(key);
        expect(text.trim(), `${key} is blank for ${dialect}`).not.toBe("");
        expect(text, `${key} resolves to nothing for ${dialect}`).not.toBe(copy.t("copy.missing"));
        expect(text, `${key} left a placeholder unfilled for ${dialect}`).not.toContain("{");
      }
    });

    it(`names the three modes distinctly for ${dialect}`, () => {
      // Three options a reader cannot tell apart is the same bug as a missing string, and a
      // dialect override is exactly where two of them would collapse into one word.
      const names = MODE_LABELS.map((key) => copyFor(dialect).t(key));
      expect(new Set(names).size, `${dialect} offers: ${names.join(", ")}`).toBe(MODE_LABELS.length);
    });
  }

  it("keeps one key per mode the control offers, in the order it offers them", () => {
    expect(THEME_MODES.map((mode) => `room.theme.mode.${mode}`)).toEqual([...MODE_LABELS]);
  });
});

/**
 * Copy that died with the screen it was written for.
 *
 * Two retirements, for the same reason and with the same rule applied to each.
 *
 * The self view mic and camera buttons became icon only, so the four VISIBLE labels they carried
 * have no renderer left. The action phrasings they sat beside are untouched: those are still the
 * buttons' accessible names, and script/e2e.mjs finds the camera button by "Turn your camera on".
 * `room.mic.level` is untouched too, since it is still the meter's title.
 *
 * The ten theme taglines went with the line of prose under the theme controls. That line made
 * the theme group two rows tall inside a settings bar whose other two groups are one, which is
 * the whole of why the bar could not sit on a single line. The words the controls are NAMED by
 * are untouched: `room.theme.label` and `room.theme.appearance` are the hidden labels now, and
 * `room.theme.title` is still the theme select's tooltip.
 *
 * This is a deletion test, which is unusual enough to say why it exists. check_copy.mjs proves
 * every language HAS every key and cannot know whether anything asks for one, so a retired key
 * is dead weight that reads as coverage: five files to keep in step by hand, forever, for a
 * string nobody renders. The same reasoning the checker already applies to a NO OP override.
 */
describe("the copy its screens stopped rendering", () => {
  const RETIRED = [
    "room.mic.mute",
    "room.mic.unmute",
    "room.camera.off",
    "room.camera.on",
    // Read off the live catalog rather than written out, so this says the stronger thing: NO
    // palette has a tagline key, including the eleventh one somebody adds next year by copying
    // the tenth. The ten that existed are exactly THEMES today.
    ...THEMES.map((theme) => `themes.${theme.id}.tagline`),
  ];

  /** Keys the same edits had to LEAVE ALONE, so a wholesale delete cannot pass this suite. */
  const KEPT = [
    "room.mic.muteLabel",
    "room.mic.unmuteLabel",
    "room.mic.level",
    "room.camera.offLabel",
    "room.camera.onLabel",
    "room.theme.label",
    "room.theme.appearance",
    "room.theme.title",
  ];

  const I18N_DIR = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = join(I18N_DIR, "..", "..", "..");
  const THIS_FILE = fileURLToPath(import.meta.url);

  function localeFiles(): string[] {
    return readdirSync(I18N_DIR).filter((name) => name.endsWith(".json"));
  }

  /** Every file that could ask for a key: the client's own source, and the node side scripts. */
  function sourceFiles(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...sourceFiles(path));
      else if (/\.(ts|tsx|mjs)$/.test(entry.name) && path !== THIS_FILE) found.push(path);
    }
    return found;
  }

  it("finds the files it sweeps, so a move cannot silently empty this test", () => {
    expect(localeFiles().length).toBeGreaterThan(1);
    expect(sourceFiles(join(REPO_ROOT, "client", "src")).length).toBeGreaterThan(10);
  });

  it("is gone from every locale file, base and dialect override alike", () => {
    const survivors: string[] = [];
    for (const file of localeFiles()) {
      const table = JSON.parse(readFileSync(join(I18N_DIR, file), "utf8")) as Record<string, string>;
      for (const key of RETIRED) if (key in table) survivors.push(`${file}  ${key}`);
    }
    expect(survivors, "no screen renders these, so every language is carrying dead words").toEqual([]);
  });

  it("is asked for nowhere in the source", () => {
    // Matched WITH its quotes. "room.mic.mute" is a prefix of "room.mic.muteLabel", and a bare
    // substring search would report the surviving accessible name as a reference to the dead
    // key, which is the kind of false green that ends with a real one being deleted.
    const files = [
      ...sourceFiles(join(REPO_ROOT, "client", "src")),
      ...sourceFiles(join(REPO_ROOT, "script")),
    ];
    const references: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const key of RETIRED) {
        if (text.includes(`"${key}"`) || text.includes(`'${key}'`)) {
          references.push(`${path.slice(REPO_ROOT.length + 1)}  ${key}`);
        }
      }
    }
    expect(references, "a key removed from the files but still asked for renders as missing copy").toEqual([]);
  });

  it("leaves the action phrasings and the meter title alone", () => {
    const english = JSON.parse(readFileSync(join(I18N_DIR, "en.json"), "utf8")) as Record<string, string>;
    for (const key of KEPT) expect(Object.keys(english)).toContain(key);
  });
});
