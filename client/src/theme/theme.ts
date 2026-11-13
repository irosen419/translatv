// Choosing a theme, resolving it, and painting it. No React in this file, and no browser types.
//
// The two edges this touches are both narrow interfaces rather than DOM types: something with a
// `style` to write custom properties to, and something that answers "does this machine want
// dark". An HTMLElement and a MediaQueryList satisfy them structurally, so the app passes the
// real ones and the tests pass two objects, and the logic underneath is the same code in both.
//
// Everything here is total. A palette id that no longer exists resolves to the default rather
// than throwing, because the ids in people's browsers outlive the ids in this repo: a palette
// that shipped once and was renamed is a string in somebody's localStorage forever, and the
// honest handling of it is a painted page in the default colours, not a white screen.

import {
  CSS_VARIABLES,
  DEFAULT_PALETTE_ID,
  THEMES,
  type Palette,
  type PaletteId,
  type ThemeDefinition,
} from "./palettes.js";

/**
 * What the reader asked for, which is not the same as what gets painted.
 *
 * "system" is a standing instruction rather than a colour: it re-resolves every time the OS
 * setting moves, which on a phone is every sunset.
 */
export type ThemeMode = "light" | "dark" | "system";

/** What actually gets painted, once the system preference has been consulted. */
export type ResolvedMode = "light" | "dark";

export interface ThemeChoice {
  paletteId: PaletteId;
  mode: ThemeMode;
}

/** The order the appearance control offers them in, and the only list of them there is. */
export const THEME_MODES: readonly ThemeMode[] = ["light", "dark", "system"];

/**
 * Where a browser with nothing stored starts.
 *
 * The mode is "system" rather than "dark": this app used to be dark only, and following the OS
 * is the one default that is not an opinion about somebody else's room. The stylesheet's :root
 * blocks hold this same palette in both halves, so the first frame is already right, before any
 * of this code has loaded.
 */
export const DEFAULT_THEME: Readonly<ThemeChoice> = {
  paletteId: DEFAULT_PALETTE_ID,
  mode: "system",
};

export function isPaletteId(value: unknown): value is PaletteId {
  return typeof value === "string" && THEMES.some((theme) => theme.id === value);
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** The theme with this id, or the default. Never undefined, and never a throw. */
export function themeById(id: string): ThemeDefinition {
  const found = THEMES.find((theme) => theme.id === id);
  if (found) return found;
  // Non null because DEFAULT_PALETTE_ID being absent from THEMES is a build time mistake, and
  // palettes.test.ts asserts it is not.
  return THEMES.find((theme) => theme.id === DEFAULT_PALETTE_ID)!;
}

export function resolveMode(mode: ThemeMode, systemPrefersDark: boolean): ResolvedMode {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function paletteFor(id: string, resolved: ResolvedMode): Palette {
  return themeById(id)[resolved];
}

/** The slice of an element applyPalette writes to. An HTMLElement is one of these. */
export interface StyleTarget {
  style: { setProperty(property: string, value: string): void };
}

/**
 * Write a palette onto an element as custom properties.
 *
 * color-scheme goes on with them, and it is not decoration: it is the only way to tell the
 * browser about the parts of the page this stylesheet cannot reach. Scrollbars, the select
 * popup, form controls and the canvas behind a rubber band scroll are all painted by the
 * browser, and without it a light theme keeps a dark scrollbar down the side of it.
 */
export function applyPalette(target: StyleTarget, palette: Palette, resolved: ResolvedMode): void {
  for (const [property, value] of Object.entries(paletteVariables(palette))) {
    target.style.setProperty(property, value);
  }
  target.style.setProperty("color-scheme", resolved);
}

/** A palette as the custom properties that carry it. The one place the mapping is walked. */
export function paletteVariables(palette: Palette): Readonly<Record<string, string>> {
  const variables: Record<string, string> = {};
  for (const [token, property] of Object.entries(CSS_VARIABLES) as Array<[keyof Palette, string]>) {
    variables[property] = palette[token];
  }
  return variables;
}

/**
 * The palette for the video well, and for everything drawn on it.
 *
 * Always the DARK half, in both modes, which is the other half of the rule at the top of
 * palettes.ts. That rule was written down as "stage and frame stay dark in both modes" and
 * implemented as exactly that: the well kept its dark background while the text, the avatar
 * initial, the alert chips and the not translated marker on top of it went on taking their
 * colour from the page. In a light theme that is near black on near black, measured at 1.04 to 1
 * for Bone, which is not low contrast, it is invisible.
 *
 * A palette rather than a separate --stage-text vocabulary, because the well is not a special
 * case needing its own words for things. It is the same interface, in the dark, inside a page
 * that may not be. Setting these as custom properties on the well's own element lets the normal
 * cascade hand them to every descendant, so nothing inside needs a rule of its own.
 */
export function wellPalette(paletteId: string): Palette {
  return themeById(paletteId).dark;
}

/** The well's palette as custom properties, ready to be spread into an inline style. */
export function wellVariables(paletteId: string): Readonly<Record<string, string>> {
  return paletteVariables(wellPalette(paletteId));
}

/** The slice of MediaQueryList this needs. */
export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export const DARK_SCHEME_QUERY = "(prefers-color-scheme: dark)";

/**
 * The live system preference, or null where there is no way to ask.
 *
 * Null is a real answer here, not a failure: an embedded webview without matchMedia still has to
 * render, and "nobody has said anything" is light, which is what the platform itself defaults to.
 */
export function browserSchemeQuery(): SchemeQuery | null {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
    return window.matchMedia(DARK_SCHEME_QUERY);
  } catch {
    return null;
  }
}

/**
 * Paint a choice, and keep it painted while the system preference moves underneath it.
 *
 * Returns the teardown, so a caller that installs this in an effect can uninstall it in the same
 * breath. Subscribing at all is skipped unless the mode is "system", because an explicit choice
 * is exactly the instruction to stop listening to the OS.
 */
export function installTheme(
  target: StyleTarget,
  choice: ThemeChoice,
  query: SchemeQuery | null,
): () => void {
  const paint = (): void => {
    const resolved = resolveMode(choice.mode, query?.matches ?? false);
    applyPalette(target, paletteFor(choice.paletteId, resolved), resolved);
  };

  paint();

  if (!query || choice.mode !== "system") return () => undefined;

  try {
    query.addEventListener("change", paint);
  } catch {
    // Safari 13 and some webviews expose matchMedia without addEventListener on the result. The
    // page is already painted by this line, so what is lost is following the OS live, and the
    // reader can still pick light or dark outright.
    return () => undefined;
  }

  return () => {
    try {
      query.removeEventListener("change", paint);
    } catch {
      // Same shape of browser, and nothing useful to do about it on the way out.
    }
  };
}
