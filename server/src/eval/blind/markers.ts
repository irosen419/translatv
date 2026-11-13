// Automatic dialect marker checks: does a translation use the form of "you" its target asks for?
//
// The same falsifiable markers script/verify_translation.mjs scores (es-AR voseo and never tu
// forms, es-ES vosotros, es-CO usted, es-MX neither voseo nor vosotros), widened to more verbs and
// made safe for free text. Two things make a naive version wrong, and both are handled here:
//
//   Accents. The prompt's own exemplars drop them ("Tenes tiempo manana?"), so a model may too,
//     and matching is done on accent stripped words. That makes "sabes" (tu) and "sabés" (vos) the
//     same word, so only verbs whose tu and vos forms differ in more than an accent are listed:
//     tienes against tenés, quieres against querés. "Tú" is the exception: the pronoun is matched
//     WITH its accent, because unaccented "tu" is the possessive, which voseo uses too.
//   Absence. A line can be translated with no second person form at all, or with the pronoun
//     dropped ("Tiene tiempo?" is usted or él). That is not a pass and not a fail, so a check can
//     come out inconclusive, and the report gives pass rates over the decided checks only.
//
// A check runs only where the item's address makes it meaningful: voseo and usted when one person
// is spoken to, vosotros and ustedes when several are.

import type { BlindItem } from "./items.js";

export type MarkerOutcome = "pass" | "fail" | "inconclusive";

export interface MarkerResult {
  applicable: boolean;
  outcome: MarkerOutcome | null;
  /** The marker words that decided it, accent stripped. */
  found: string[];
}

/** Vos forms whose tu form differs by more than an accent, so they survive accent stripping. */
const VOSEO = new Set([
  "vos", "sos", "tenes", "queres", "podes", "venis", "decis", "pensas", "contas", "volves", "dormis",
  "sentis", "preferis", "entendes", "encontras", "recordas", "jugas", "empezas", "perdes", "acordas",
  "veni", "deci", "decime", "contame", "tene",
]);

/** Tu forms, the same verbs. Not "tu" (the possessive) and not "cuentas" (also a noun). */
const TUTEO = new Set([
  "tienes", "quieres", "puedes", "eres", "vienes", "dices", "piensas", "vuelves", "duermes",
  "sientes", "prefieres", "entiendes", "encuentras", "recuerdas", "juegas", "empiezas", "pierdes",
  "dime", "cuentame",
]);

/** Vosotros forms. Accented -áis and -éis endings are caught as well, by pattern (vosotrosEnding). */
const VOSOTROS = new Set([
  "vosotros", "vosotras", "vuestro", "vuestra", "vuestros", "vuestras", "os", "teneis", "quereis",
  "podeis", "sabeis", "estais", "habeis", "haceis", "sois", "vais", "venid", "decid", "mirad",
]);

const strip = (word: string): string => word.normalize("NFD").replace(/\p{M}/gu, "");

/** Lowercased words, as written (accents kept). */
function words(text: string): string[] {
  return text.toLowerCase().normalize("NFC").match(/\p{L}+/gu) ?? [];
}

/** A present tense vosotros verb as written with its accent: queréis, estáis. Not país, not seis. */
const vosotrosEnding = (word: string): boolean => /(áis|éis)$/u.test(word);

interface Found {
  voseo: string[];
  tuteo: string[];
  vosotros: string[];
  usted: string[];
  ustedes: string[];
}

function scan(text: string): Found {
  const found: Found = { voseo: [], tuteo: [], vosotros: [], usted: [], ustedes: [] };
  for (const word of words(text)) {
    const bare = strip(word);
    if (VOSEO.has(bare)) found.voseo.push(bare);
    if (TUTEO.has(bare) || word === "tú") found.tuteo.push(word === "tú" ? "tú" : bare);
    if (VOSOTROS.has(bare) || vosotrosEnding(word)) found.vosotros.push(bare);
    if (bare === "usted") found.usted.push(bare);
    if (bare === "ustedes") found.ustedes.push(bare);
  }
  return found;
}

const NOT_APPLICABLE: MarkerResult = { applicable: false, outcome: null, found: [] };

/**
 * Decide from what was found: any `bad` word fails, otherwise any `good` word passes, otherwise
 * nothing was said either way.
 */
function decide(bad: string[], good: string[]): MarkerResult {
  if (bad.length > 0) return { applicable: true, outcome: "fail", found: bad };
  if (good.length > 0) return { applicable: true, outcome: "pass", found: good };
  return { applicable: true, outcome: "inconclusive", found: [] };
}

export function markerCheck(item: Pick<BlindItem, "tgt" | "address">, text: string): MarkerResult {
  const f = scan(text);
  const { tgt, address } = item;
  if (tgt === "es-MX" && address !== "none") {
    // A negative check: tu and ustedes need no marker, so anything free of voseo and vosotros passes.
    const bad = [...f.voseo, ...f.vosotros];
    return { applicable: true, outcome: bad.length > 0 ? "fail" : "pass", found: bad };
  }
  if (address === "singular") {
    if (tgt === "es-AR") return decide([...f.tuteo, ...f.vosotros], f.voseo);
    if (tgt === "es-CO") return decide([...f.tuteo, ...f.voseo], f.usted);
    return NOT_APPLICABLE;
  }
  if (address === "plural") {
    if (tgt === "es-ES") return decide(f.ustedes, f.vosotros);
    if (tgt === "es-AR" || tgt === "es-CO") return decide(f.vosotros, f.ustedes);
    return NOT_APPLICABLE;
  }
  return NOT_APPLICABLE;
}
