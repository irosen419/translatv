// Where the chosen theme lives between page loads.
//
// Reading is TOTAL by construction: every way the stored value can be something other than what
// was written ends at the default, and none of them throws. That matters more here than it looks
// like it should, because this call is on the path to the first paint. A throw is not a wrong
// colour, it is a white page with nothing on it to report the problem in.
//
// Writing is best effort. A private window that refuses the write still gets the theme it asked
// for; it just gets the default again on the next visit, which is not worth interrupting a video
// call to mention.

import { type WebStorage } from "../lib/browserStorage.js";
import { DEFAULT_THEME, isPaletteId, isThemeMode, type ThemeChoice } from "./theme.js";

export const THEME_KEY = "translatv.theme";

/**
 * The stored choice, field by field, with the default standing in for anything unusable.
 *
 * Field by field rather than all or nothing on purpose: a palette that was renamed out of the
 * table should not also cost the reader the light or dark they picked. Falling back per field
 * loses the least of what they actually chose.
 */
export function loadTheme(store: WebStorage | null): ThemeChoice {
  const stored = read(store);
  if (stored === null) return { ...DEFAULT_THEME };

  const { paletteId, mode } = stored as Partial<Record<keyof ThemeChoice, unknown>>;
  return {
    paletteId: isPaletteId(paletteId) ? paletteId : DEFAULT_THEME.paletteId,
    mode: isThemeMode(mode) ? mode : DEFAULT_THEME.mode,
  };
}

export function saveTheme(store: WebStorage | null, choice: ThemeChoice): void {
  if (!store) return;
  try {
    store.setItem(THEME_KEY, JSON.stringify(choice));
  } catch {
    // Storage refused. Nothing to do and nothing to say: see the note at the top.
  }
}

/** The stored object, or null for absent, unreadable, unparseable, or not an object. */
function read(store: WebStorage | null): object | null {
  if (!store) return null;

  let raw: string | null;
  try {
    raw = store.getItem(THEME_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Hand edited, half written by a crashed tab, or left behind by an older format.
    return null;
  }

  // An array is an object to typeof, and has neither field, so it would resolve to the default
  // anyway. Rejecting it here keeps that an intention rather than a coincidence.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed;
}
