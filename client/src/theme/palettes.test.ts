// What this suite guards about the palette table itself.
//
// The values are a design artifact: they were measured for WCAG AA and for colour blindness
// separation, and nothing here re-measures them. What it does check is the three ways the table
// can be WRONG rather than merely ugly: a theme missing a token, a value that is not a colour at
// all, and the one design invariant that survives being written down.

import { describe, expect, it } from "vitest";

import { CSS_VARIABLES, THEMES, type Palette } from "./palettes.js";
import { wellPalette } from "./theme.js";

const TOKENS = Object.keys(CSS_VARIABLES) as Array<keyof Palette>;
const HEX = /^#[0-9a-f]{6}$/;

/**
 * WCAG relative luminance, which is what "dark" has to mean here to be testable.
 *
 * Not the mean of the channels: a mid green and a mid blue at the same numeric average are not
 * remotely the same brightness to an eye, and the video well invariant is about what the eye
 * does next to a photograph.
 */
function luminance(hex: string): number {
  const channel = (pair: string): number => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(hex.slice(1, 3));
  const g = channel(hex.slice(3, 5));
  const b = channel(hex.slice(5, 7));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
function contrast(one: string, other: string): number {
  const a = luminance(one);
  const b = luminance(other);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The ceiling for a surface that sits against video.
 *
 * 0.05 is the same constant WCAG adds to both sides of a contrast ratio, which makes it the
 * brightness below which a surface stops behaving like a light and starts behaving like a
 * backdrop. In hex it is somewhere around #3a3a3a. The darkest chrome in the table sits at about
 * 0.029, so this leaves room for a future theme without leaving room for a light one.
 */
const DARK_ENOUGH_FOR_VIDEO = 0.05;

const MODES = ["light", "dark"] as const;

describe("every theme", () => {
  for (const theme of THEMES) {
    for (const mode of MODES) {
      const palette = theme[mode];

      it(`${theme.id} ${mode} defines exactly the tokens CSS_VARIABLES names`, () => {
        // Both directions. A missing token renders as an empty custom property, which paints as
        // transparent rather than as anything anyone would notice in review. An extra one is a
        // value the stylesheet can never read, so it looks like coverage and is not.
        expect(Object.keys(palette).sort()).toEqual([...TOKENS].sort());
      });

      it(`${theme.id} ${mode} states every colour as a six digit hex`, () => {
        const wrong = TOKENS.filter((token) => !HEX.test(palette[token]));
        expect(wrong).toEqual([]);
      });
    }

    // The invariant from the top of palettes.ts, asserted rather than left as prose.
    //
    // The video well surrounds a photograph. A light surround is glare, and it is glare in a
    // light theme too, so a light theme lightens the chrome and never the well. This is the one
    // rule a new palette is most likely to break, because filling in a light row by lightening
    // every value in the dark row is the obvious way to write one.
    it(`${theme.id} keeps the video well dark in BOTH modes`, () => {
      for (const mode of MODES) {
        expect(luminance(theme[mode].stage)).toBeLessThan(DARK_ENOUGH_FOR_VIDEO);
        expect(luminance(theme[mode].frame)).toBeLessThan(DARK_ENOUGH_FOR_VIDEO);
      }
    });
  }

  it("has a unique id per theme, so the picker cannot show two of the same", () => {
    const ids = THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * The other half of the video well rule, and the one that was missing.
 *
 * "The well stays dark in both modes" was only ever written down about the well's own two
 * surfaces. The text, the avatar initial, the alert chips and the not translated marker are all
 * drawn ON those surfaces, and they were taking their colours from the page, so a light theme
 * put near black text on a near black well: Bone light measured 1.04 to 1, which is not low
 * contrast, it is invisible. A picker that produces an unreadable screen in half its settings is
 * a broken picker, so this is measured rather than reasoned about.
 *
 * AA for body text is 4.5 to 1. Asserted against both surfaces of the well, because the
 * placeholder sits on --stage in the main frame and on --frame inside the self view.
 */
describe("anything drawn on the video well", () => {
  /** Every colour the app paints as a foreground somewhere inside the well. */
  const FOREGROUNDS = ["text", "muted", "accent", "accentFill", "warn", "danger"] as const;
  const AA_BODY_TEXT = 4.5;
  const SURFACES = ["stage", "frame"] as const;

  for (const theme of THEMES) {
    for (const mode of MODES) {
      // Both modes, although the well palette does not depend on the mode. That is the point:
      // twenty variants are measured, and twenty have to pass, which is what stops the well
      // quietly starting to follow the page again.
      it(`${theme.id} ${mode} keeps every foreground over the well legible`, () => {
        const palette = wellPalette(theme.id);
        const failures = SURFACES.flatMap((surface) =>
          FOREGROUNDS.filter(
            (foreground) => contrast(palette[foreground], palette[surface]) < AA_BODY_TEXT,
          ).map(
            (foreground) =>
              `${foreground} on ${surface}: ${contrast(palette[foreground], palette[surface]).toFixed(2)} to 1`,
          ),
        );
        expect(failures).toEqual([]);
      });
    }
  }
});

/**
 * The same measurement, on the PAGE surfaces this time.
 *
 * The header of palettes.ts promises that "every text pair in every theme clears WCAG AA against
 * the surface it actually sits on", and until this block nothing measured that. Only the well
 * was covered, and the well uses the dark half in both modes, so a light half could ship text
 * that was invisible on its own page. Changing Cocoa's light text to #fcfcfc, near white on a
 * white surface at 1.05 to 1, left all 460 client tests passing.
 *
 * The pairings are the ones the stylesheet actually draws, not every combination the tokens
 * allow. A cross product would be easy and would mostly assert things the app never renders,
 * which is how a guard ends up being loosened later by somebody who is right to loosen it.
 *
 * The wash tokens carry text of their own hue (.notice.bad is --danger on --danger-wash, the
 * chips likewise), so those are body text pairs too. --accent-ink is the one reversal: it is the
 * only foreground meant for --accent-fill.
 */
describe("anything drawn on the page", () => {
  const AA_BODY_TEXT = 4.5;

  /** Foreground over background, as the stylesheet pairs them. */
  const PAIRINGS: ReadonlyArray<readonly [keyof Palette, keyof Palette]> = [
    ...(["bg", "surface", "surface2"] as const).flatMap(
      (surface) =>
        (["text", "muted", "accent", "warn", "danger"] as const).map(
          (foreground) => [foreground, surface] as const,
        ),
    ),
    ["accent", "accentWash"],
    // button.toggle-on:hover paints --accent-wash and, unlike button.danger:hover, sets no
    // colour of its own, so the text on it is the global button rule's --text.
    ["text", "accentWash"],
    ["warn", "warnWash"],
    ["danger", "dangerWash"],
    ["accentInk", "accentFill"],
  ];

  for (const theme of THEMES) {
    for (const mode of MODES) {
      it(`${theme.id} ${mode} keeps every foreground over its own surfaces legible`, () => {
        const palette = theme[mode];
        const failures = PAIRINGS.filter(
          ([foreground, surface]) => contrast(palette[foreground], palette[surface]) < AA_BODY_TEXT,
        ).map(
          ([foreground, surface]) =>
            `${foreground} on ${surface}: ${contrast(palette[foreground], palette[surface]).toFixed(2)} to 1`,
        );
        expect(failures).toEqual([]);
      });
    }
  }
});
