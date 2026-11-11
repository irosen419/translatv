// The React side of the theme.
//
// Deliberately thin, and split in two, because the two halves have different numbers of rightful
// callers. Any control that wants to read or change the theme calls useTheme. Exactly ONE place
// paints the document, and that is the root: two components running the paint effect would
// install two media query listeners and write the same custom properties twice, which works and
// is still two owners of one element.

import { useEffect, useMemo, type CSSProperties } from "react";

import { browserStorage, type WebStorage } from "../lib/browserStorage.js";
import { useStore } from "../state/store.js";
import { saveTheme } from "./storage.js";
import { browserSchemeQuery, installTheme, wellVariables, type ThemeChoice } from "./theme.js";

export interface ThemeControls {
  theme: ThemeChoice;
  /** Change one field or both. Persisting is part of choosing, not a separate step to remember. */
  choose(change: Partial<ThemeChoice>): void;
}

/**
 * Change the theme, and write the new one down.
 *
 * Outside React so it can be called and asserted on directly. A partial change rather than a
 * whole choice, because every control on screen owns exactly one of the two fields and none of
 * them should have to restate the other.
 */
export function chooseTheme(
  change: Partial<ThemeChoice>,
  store: WebStorage | null = browserStorage(),
): void {
  const next: ThemeChoice = { ...useStore.getState().theme, ...change };
  useStore.getState().setTheme(next);
  saveTheme(store, next);
}

/** The theme and the way to change it. Safe from anywhere: the state lives in the store. */
export function useTheme(): ThemeControls {
  const theme = useStore((state) => state.theme);
  return { theme, choose: chooseTheme };
}

/**
 * Paint the chosen theme onto the document, and follow the OS while the mode is "system".
 *
 * Called once, at the root. The effect re-runs whenever the choice changes, and its teardown
 * drops the media query listener, so switching from "system" to "dark" stops the app listening
 * to the OS rather than leaving a listener behind that quietly repaints over the choice.
 */
export function useApplyTheme(): void {
  const theme = useStore((state) => state.theme);

  useEffect(
    () => installTheme(document.documentElement, theme, browserSchemeQuery()),
    [theme],
  );
}

/**
 * The inline style that turns an element into a piece of the video well.
 *
 * Put it on anything drawn against the video, and every descendant inherits the dark palette
 * through the ordinary cascade: custom properties inherit, so .placeholder, .avatar, .alerts,
 * .self-control, .camera-error and the two subtitle overlays need no rule of their own. That is
 * the whole reason this is an inline style on the well rather than a second stylesheet or a
 * parallel set of token names.
 *
 * It does not depend on the appearance mode, only on which palette is chosen, which is why it is
 * memoized on the palette id alone.
 *
 * The body is a plain function so it can be asserted without a renderer. That is not tidiness:
 * every link in this chain was tested EXCEPT what this returns, and swapping wellVariables here
 * for the page palette put the original 1.04 to 1 bug back on screen with the whole suite green.
 */
export function wellStyleFor(paletteId: string): CSSProperties {
  return {
    ...wellVariables(paletteId),
    // camelCase, deliberately, and not part of wellVariables. React routes a style key to
    // setProperty only when it starts with --, and assigns everything else onto the style
    // object, where a hyphenated standard property would land as a plain field and paint
    // nothing. This one is worth having: it is what makes the scrollbar on the conversation
    // log, and the caret in the composer that sits over the video, dark along with the rest
    // of the well.
    colorScheme: "dark",
  } as CSSProperties;
}

export function useVideoWellStyle(): CSSProperties {
  const paletteId = useStore((state) => state.theme.paletteId);

  return useMemo(() => wellStyleFor(paletteId), [paletteId]);
}
