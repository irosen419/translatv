// The after call screen for saved corrections (owner decisions C1 to C5, 2026-10-09).
//
// A correction someone made in a call is a TERM: a phrase from a line they read, and its fix.
// When their call ends, the ones they made themselves are screened here and the survivors join
// their stored glossary, which loads into every call they make after. Rules only: no model is
// asked, so nothing here spends, and nothing here needs the ledger.
//
// Rules cannot see a flipped meaning ("sí" saved as "no"). The backstop for that is the person
// themselves: the web client lists their saved entries, each with a delete.

import {
  comparablePhrase,
  DIALECT_CODES,
  LIMITS,
  savableTerm,
  translationNeed,
  type GlossaryEntry,
} from "@translatv/shared";

/** Why a correction was not saved. Counted in the log, never shown with its text. */
export type ScreenReason = "empty" | "identical" | "too_long" | "not_a_term" | "instruction" | "direction";

export type ScreenVerdict = { ok: true; entry: GlossaryEntry } | { ok: false; reason: ScreenReason };

/**
 * Control characters become a space and format characters go, then whitespace is collapsed.
 *
 * Control characters include the newline, which matters beyond tidiness: the prompt lists the
 * glossary one entry per line, so a newline inside a term is how one entry would forge another.
 * Format characters (a right to left override, a zero width space) change what a person sees
 * without changing what is stored, so the entry on their list would not be the one in the prompt.
 */
function clean(text: string): string {
  return text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

// A word edge that knows about accented letters. JavaScript's \b counts only ASCII letters as word
// characters, so "instrucción" would end at the "ó".
const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const word = (alternatives: string) => `${START}(?:${alternatives})${END}`;
const near = (first: string, second: string) =>
  new RegExp(`${word(first)}[^.!?]{0,40}?${word(second)}`, "iu");

/**
 * Text that reads as instructions to the translation model rather than as a term.
 *
 * A second lock, not the first: the prompt already fences every glossary entry off as data
 * (server/src/translate/prompt.ts). So these aim at the shapes an injection takes, and each is
 * narrow enough that ordinary speech gets through: "olvidate" (forget it), "eres" (you are) and
 * "a partir de ahora" (from now on) are all real terms, and corrections.test.ts keeps them passing.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  // Markup and fences: the prompt's own tags, code fences, template braces, square brackets (a
  // "[SYSTEM]" header), and so the arrows the prompt writes between a term and its translation
  // ("->", "=>", both caught by ">"). No glossary term needs any of them.
  /[<>`{}[\]]/u,
  // A role label, as in a chat transcript. Not "modelo:", which is how a product is described.
  new RegExp(`${word("system|assistant|user|human|sistema|asistente|usuario")}\\s*:`, "iu"),
  // "Ignore the instructions", "olvida las reglas" and their kin. The verbs are the imperatives
  // and infinitives only: "olvidé las reglas" (I forgot the rules) and "ignoró las indicaciones"
  // (she ignored the directions) are things people say, and the first screen dropped them.
  near(
    "ignore|disregard|forget|override|bypass|ignora|ignorá|ignorar|ignoren|olvida|olvidá|olvidar|olviden|olvidate|omite|omití|omitir|descarta|descartá|descartar",
    "instructions?|prompts?|rules|guidelines|above|previous|prior|before|instrucci\\p{L}*|reglas|indicaciones|anteriore?s?|previas?",
  ),
  near("new|nuevas?", "instructions?|rules|instrucciones|reglas"),
  // Talking to the model about itself, or giving it a part to play.
  new RegExp(
    `${word("system prompt|prompt del sistema|you are now|as an ai|como (?:una )?ia|ahora eres|ahora sos|pretend you are|pretend to be|act as|finge que eres|hac[ée] de cuenta que sos")}`,
    "iu",
  ),
  near("you are|eres|sos", "an? (?:ai|assistant|language model|chatbot)|una? (?:ia|asistente)"),
  // A blanket order about translating: "translate everything as yes", "instead of translating".
  near("translate|traduc\\p{L}*", "everything|every|all|always|instead|todo|todas?|todos|siempre"),
  near("instead of|en vez de|en lugar de", "translat\\p{L}*|traduc\\p{L}*"),
  // An order about how to answer: "respond only with OK". Not "answer the phone", and not
  // "responde solo a su jefe" (she answers only to her boss), which are terms.
  near("respond|reply|answer|output", "only with|with only|nothing but"),
  near("responde|respondé|contesta|contestá", "(?:solo|solamente|únicamente) con"),
];

/**
 * Checked on the NFKC form as well as the text itself, so fullwidth and other compatibility forms
 * ("ＳＹＳＴＥＭ:", "＜/glossary＞") fold to the plain characters the patterns name. What is saved
 * is the text as typed; only the check folds. A look alike from another script (a Cyrillic "о" in
 * "ignоre") does not fold, and gets through: rules have a ceiling, which is why the saved list has
 * a delete.
 */
function readsAsInstructions(text: string): boolean {
  const folded = text.normalize("NFKC");
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text) || pattern.test(folded));
}

/**
 * Screen one correction. On success the entry carries the CLEANED texts, which are what is saved.
 *
 * The term rule: the phrase is at most TERM_MAX_WORDS words (shared/src/corrections.ts). The dialog
 * prefills the whole line, so without it the untouched default would save the other person's whole
 * sentence, which owner decision C1 rejected. The fix is not limited in words: one term can take a
 * longer rendering.
 *
 * The direction rule: a correction fixes a translation someone read, so its phrase is in the
 * line's dialect and its fix in the reader's, and those are two different languages. The socket
 * layer builds the pair from exactly those two (handleCorrect), and refuses a correction of
 * your own line, so a pair that fails here was not read as a translation at all.
 */
export function screenCorrection(candidate: GlossaryEntry): ScreenVerdict {
  const source = clean(candidate.source);
  const target = clean(candidate.target);

  if (source.length === 0 || target.length === 0) return { ok: false, reason: "empty" };
  if (source.length > LIMITS.glossaryTerm || target.length > LIMITS.glossaryTranslation) {
    return { ok: false, reason: "too_long" };
  }
  if (!savableTerm(source)) return { ok: false, reason: "not_a_term" };
  if (comparablePhrase(source) === comparablePhrase(target)) return { ok: false, reason: "identical" };
  if (readsAsInstructions(source) || readsAsInstructions(target)) return { ok: false, reason: "instruction" };

  const { sourceDialect, targetDialect } = candidate;
  if (
    !DIALECT_CODES.includes(sourceDialect) ||
    !DIALECT_CODES.includes(targetDialect) ||
    translationNeed(sourceDialect, targetDialect) !== "yes"
  ) {
    return { ok: false, reason: "direction" };
  }

  return { ok: true, entry: { source, target, sourceDialect, targetDialect } };
}

/**
 * Add entries to a glossary by the room's rules: each one goes first, an entry with the same
 * phrase (case blind) is replaced rather than kept beside it, and past `max` the oldest go. So at
 * the limit the newest wins, as in a room (owner decision C3).
 *
 * `incoming` is oldest first, the order the corrections were made in, so the last one made ends
 * up at the top. Returns a new list; the one given is not changed.
 */
export function mergeNewestFirst(
  existing: readonly GlossaryEntry[],
  incoming: readonly GlossaryEntry[],
  max: number,
): GlossaryEntry[] {
  const merged = [...existing];
  for (const entry of incoming) {
    const key = entry.source.toLowerCase();
    const index = merged.findIndex((e) => e.source.toLowerCase() === key);
    if (index !== -1) merged.splice(index, 1);
    merged.unshift(entry);
  }
  return merged.slice(0, max);
}
