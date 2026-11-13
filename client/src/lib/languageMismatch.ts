// "You are speaking a different language than the one you picked."
//
// In an owner test (2026-11-13) a phone set to Spanish was spoken to in English. The recognizer
// wrote the English down as best it could, the translator was told it was Spanish, and the other
// person read English "translated" into English: the line back almost word for word, with a
// stray "Una" where "One" had been. Nothing on either screen said why.
//
// The tell is cheap and needs no model call: for your own SPOKEN lines, a translation that shares
// almost every word with the line it came from was not really translated. One such line can be a
// name, a quote, or a word both languages share, so it takes two of the last three.

import type { RenderedLine } from "@translatv/shared";

/** Below this many words a line cannot be judged: "Okay" and "Hola Ana" are the same in both. */
const MIN_WORDS = 4;
/** Share of the words two lines have in common past which one is the other, untranslated. */
const SAME_ENOUGH = 0.6;
const WINDOW = 3;
const NEEDED = 2;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .split(/[^\p{L}\p{N}']+/u)
      .filter(Boolean),
  );
}

/** Whether `translated` is essentially `text` again. */
export function looksUntranslated(text: string, translated: string): boolean {
  const a = words(text);
  const b = words(translated);
  if (a.size < MIN_WORDS || b.size < MIN_WORDS) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared) >= SAME_ENOUGH;
}

/** Whether your recent spoken lines suggest you are speaking the other language. */
export function speakingOtherLanguage(lines: readonly RenderedLine[], selfId: string | null): boolean {
  if (!selfId) return false;
  const recent = lines
    .filter((l) => l.from === selfId && l.source === "speech" && l.translationStatus === "ok" && l.translated)
    .slice(-WINDOW);
  return recent.filter((l) => looksUntranslated(l.text, l.translated!)).length >= NEEDED;
}
