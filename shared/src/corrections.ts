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
