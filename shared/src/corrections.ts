// Term level corrections (owner decision C1, 2026-10-09): what the two sides agree a phrase is.
//
// A correction names a PHRASE from the line it fixes, and the fix for that phrase. The phrase has
// to come from the line: the dialog prefills it with the whole line and the person trims it to the
// words that were wrong. Both the client (to say so before sending) and the server (to refuse
// anything else) ask the same question here, so the two cannot come to disagree about it.

/**
 * The comparable form of a phrase: one Unicode composition, single spaces, no ends, lower case.
 *
 * NFC because "vení" can arrive precomposed or as "i" plus a combining accent, and a person cannot
 * see which one they typed. Accents are kept: "sí" and "si" are different words, and a correction
 * of one is not a correction of the other.
 */
export function comparablePhrase(text: string): string {
  return text.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Whether `phrase` appears in `lineText`, by comparablePhrase. An empty phrase never does. */
export function phraseInLine(phrase: string, lineText: string): boolean {
  const needle = comparablePhrase(phrase);
  if (needle.length === 0) return false;
  return comparablePhrase(lineText).includes(needle);
}

/** Whether two phrases are the same by comparablePhrase. */
export function samePhrase(a: string, b: string): boolean {
  return comparablePhrase(a) === comparablePhrase(b);
}

/**
 * The most words a correction may have and still be saved to an account.
 *
 * Owner decision C1 (2026-10-09) made a saved correction a TERM, and rejected saving any line that
 * merely fits 200 characters because "That still stores the other person's words." The dialog
 * prefills the whole line, so without a word limit the untouched default, open and press Save,
 * would be exactly the rejected option: a whole sentence of somebody's, kept for good (measured in
 * review). Six words holds a name, a term or an idiom ("no le cuentes a nadie") and not a sentence
 * of news. A longer correction still fixes the call it was made in; it is just not saved.
 */
export const TERM_MAX_WORDS = 6;

/** Whether `phrase` is short enough to be saved as a term: 1 to TERM_MAX_WORDS words. */
export function savableTerm(phrase: string): boolean {
  const words = phrase.normalize("NFC").match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  return words.length >= 1 && words.length <= TERM_MAX_WORDS;
}
