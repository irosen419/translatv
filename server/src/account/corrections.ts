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
  translationNeed,
  type GlossaryEntry,
} from "@translatv/shared";

/** Why a correction was not saved. Counted in the log, never shown with its text. */
export type ScreenReason = "empty" | "identical" | "too_long" | "instruction" | "direction";

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
  // Markup and fences: the prompt's own tags, code fences, template braces, and the arrow the
  // prompt writes between a term and its translation. No glossary term needs any of them.
  /[<>`{}]/u,
  /->|=>/u,
  // A role label, as in a chat transcript.
  new RegExp(`${word("system|assistant|user|human|sistema|asistente|usuario|modelo|model")}\\s*:`, "iu"),
  // "Ignore the instructions", "olvida las reglas" and their kin.
  near(
    "ignore|disregard|forget|override|bypass|ignor\\p{L}*|olvid\\p{L}*|omit\\p{L}*|descart\\p{L}*|saltea\\p{L}*",
    "instructions?|prompts?|rules|guidelines|above|previous|prior|instrucci\\p{L}*|reglas|indicaciones|anteriores|previas",
  ),
  // Talking to the model about itself.
  new RegExp(
    `${word("system prompt|prompt del sistema|you are now|as an ai|como (?:una )?ia|ahora eres|ahora sos")}`,
    "iu",
  ),
  near("you are|eres|sos", "an? (?:ai|assistant|language model|chatbot)|una? (?:ia|asistente|modelo)"),
  // A blanket order about translating: "translate everything as yes".
  near("translate|traduc\\p{L}*", "everything|every|all|always|instead|todo|todas?|todos|siempre"),
  // An order about how to answer: "respond only with OK". Not "answer the phone", which is a term.
  near(
    "respond|reply|answer|output|responde|respond[ée]|contesta|contest[áa]",
    "only|solo|solamente|únicamente",
  ),
];

function readsAsInstructions(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Screen one correction. On success the entry carries the CLEANED texts, which are what is saved.
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
