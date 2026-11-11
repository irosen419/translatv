// The part of the hook that is not React.
//
// The client suite runs in the node environment with no DOM and no renderer, by the same
// decision that keeps every other component's logic in a plain module: nothing here mounts a
// component. So useTheme is deliberately two lines of React over two things that can be called
// directly, and those two things are what this file tests.
//
//   chooseTheme   what happens when somebody moves a control: the store changes and the choice
//                 is written down. Tested here.
//   installTheme  what the effect does: paint, then keep painting while the OS moves underneath.
//                 Tested in theme.test.ts, including the system mode case.
//   wellStyleFor  what useVideoWellStyle hands the video well. Tested here, and it has to be
//                 tested SOMEWHERE: every other link in that chain was covered and this one was
//                 not, which let the well quietly go back to the page palette with the whole
//                 suite green. See the block at the bottom of this file.

import { beforeEach, describe, expect, it } from "vitest";

import type { WebStorage } from "../lib/browserStorage.js";
import { useStore } from "../state/store.js";
import { loadTheme, THEME_KEY } from "./storage.js";
import { chooseTheme, wellStyleFor } from "./useTheme.js";
import { CSS_VARIABLES, THEMES } from "./palettes.js";
import { DEFAULT_THEME, wellPalette } from "./theme.js";

function memoryStore(): WebStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

describe("the theme the app starts in", () => {
  beforeEach(() => {
    useStore.setState({ theme: { ...DEFAULT_THEME } });
  });

  it("is the default when this browser has never been told otherwise", () => {
    // Node has no localStorage, which is the same situation as a browser that refuses it.
    expect(useStore.getState().theme).toEqual(DEFAULT_THEME);
  });

  it("changes the palette without disturbing the appearance mode", () => {
    chooseTheme({ mode: "light" }, memoryStore());
    chooseTheme({ paletteId: "cocoa" }, memoryStore());
    expect(useStore.getState().theme).toEqual({ paletteId: "cocoa", mode: "light" });
  });

  it("writes the whole choice down, so a reload comes back to it", () => {
    const store = memoryStore();
    chooseTheme({ paletteId: "harbor" }, store);
    chooseTheme({ mode: "dark" }, store);

    expect(store.data[THEME_KEY]).toBeDefined();
    expect(loadTheme(store)).toEqual({ paletteId: "harbor", mode: "dark" });
  });

  it("keeps the choice for this page even when it cannot be written down", () => {
    chooseTheme({ paletteId: "iris" }, null);
    expect(useStore.getState().theme.paletteId).toBe("iris");
  });
});

/**
 * What the well actually gets.
 *
 * The chain that keeps the video well dark is four links: wellPalette returns the dark half
 * (theme.test.ts), that half clears AA on the well (palettes.test.ts), styles.css names
 * .video-area (tokens.test.ts), and the element binds its style to this hook (tokens.test.ts).
 * The fourth link proves the WIRING and says nothing about what travels down it. Replacing
 * wellVariables here with the page palette left all 486 tests passing, typecheck clean, and put
 * the original bug back on a real screen: Bone light gave 1.04 to 1 on the well, with the room
 * code somebody has to read aloud rendered invisible.
 *
 * So this asserts the payload, for every theme rather than for one, since a table that is meant
 * to grow should not have a guard that only covers the palette somebody happened to pick.
 */
describe("the style handed to the video well", () => {
  for (const theme of THEMES) {
    it(`gives ${theme.id} the dark half, whatever the page is painted in`, () => {
      const style = wellStyleFor(theme.id) as Record<string, string>;
      const dark = wellPalette(theme.id);
      for (const [token, variable] of Object.entries(CSS_VARIABLES)) {
        expect(
          style[variable],
          `the well's ${variable} is not the dark half's, so anything drawn on the video follows the page instead`,
        ).toBe(dark[token as keyof typeof dark]);
      }
    });
  }

  it("asks for a dark colour scheme, which is what the scrollbar and the caret read", () => {
    expect(
      (wellStyleFor(DEFAULT_THEME.paletteId) as Record<string, string>)["colorScheme"],
      "without this the conversation log's scrollbar and the composer's caret are painted light over the video",
    ).toBe("dark");
  });
});
