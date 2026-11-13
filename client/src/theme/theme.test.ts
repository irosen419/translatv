// The theme logic, away from React and away from a DOM.
//
// Everything here is a pure function over a palette table plus two injected edges: something
// with a `style` to write to, and something that answers "does the OS want dark". Both are
// interfaces rather than browser types, which is what lets this whole suite run in the node
// environment the rest of the client tests run in.

import { describe, expect, it, vi } from "vitest";

import {
  applyPalette,
  DEFAULT_THEME,
  installTheme,
  paletteFor,
  resolveMode,
  themeById,
  wellPalette,
  wellVariables,
  type SchemeQuery,
  type StyleTarget,
} from "./theme.js";
import { CSS_VARIABLES, DEFAULT_PALETTE_ID, THEMES, type Palette } from "./palettes.js";

/** An element's style, reduced to the one method applyPalette uses. */
function styleTarget(): StyleTarget & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    style: {
      setProperty(property: string, value: string) {
        written.set(property, value);
      },
    },
  };
}

/**
 * A stand in for matchMedia("(prefers-color-scheme: dark)").
 *
 * `matches` is readonly on the real thing and on the interface, and writable here, which is the
 * whole point: moving it is how a test says "the reader changed their OS setting".
 */
interface FakeQuery extends SchemeQuery {
  matches: boolean;
  listeners: Set<() => void>;
}

function schemeQuery(matches: boolean): FakeQuery {
  const listeners = new Set<() => void>();
  return {
    matches,
    listeners,
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
}

describe("the default theme", () => {
  it("names a palette that actually exists in the table", () => {
    // A default that is not in THEMES is the worst kind of wrong: every lookup silently falls
    // back to it, and the fallback is itself missing, so nothing has a colour and nothing says
    // why. It is also the exact thing a rename breaks.
    expect(THEMES.map((theme) => theme.id)).toContain(DEFAULT_PALETTE_ID);
    expect(DEFAULT_THEME.paletteId).toBe(DEFAULT_PALETTE_ID);
  });

  it("follows the operating system until somebody says otherwise", () => {
    expect(DEFAULT_THEME.mode).toBe("system");
  });
});

describe("resolving a mode", () => {
  it("takes an explicit mode at its word, whatever the OS says", () => {
    expect(resolveMode("light", true)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
  });

  it("follows the supplied system preference while the mode is system", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
  });
});

describe("looking a theme up", () => {
  it("finds a theme by its id", () => {
    expect(themeById("ember").name).toBe("Ember");
  });

  it("falls back to the default for an id it has never heard of, rather than throwing", () => {
    // Reachable from stale storage: a palette that shipped once and was renamed is a string in
    // somebody's localStorage forever. Throwing here would be a blank page on their next visit.
    expect(themeById("no-such-palette").id).toBe(DEFAULT_PALETTE_ID);
  });

  it("returns the light or the dark half, as asked", () => {
    const bone = themeById("bone");
    expect(paletteFor("bone", "light")).toEqual(bone.light);
    expect(paletteFor("bone", "dark")).toEqual(bone.dark);
  });

  it("falls back to the default palette's half for an unknown id", () => {
    expect(paletteFor("no-such-palette", "dark")).toEqual(themeById(DEFAULT_PALETTE_ID).dark);
  });
});

describe("the video well palette", () => {
  // The well is dark in every theme and in every mode, so everything drawn on it has to come
  // from the dark half too. The bug this closes was half a rule: the well kept its dark
  // background out of the palette and then inherited the page's foregrounds over the top.
  for (const theme of THEMES) {
    it(`gives the well ${theme.id}'s dark half, not the half the page is painted in`, () => {
      expect(wellPalette(theme.id)).toEqual(theme.dark);
      expect(wellPalette(theme.id)).not.toEqual(theme.light);
    });
  }

  it("falls back to the default theme's dark half for an id it has never heard of", () => {
    expect(wellPalette("no-such-palette")).toEqual(themeById(DEFAULT_PALETTE_ID).dark);
  });

  it("hands them over as every custom property CSS_VARIABLES names, ready for an inline style", () => {
    const variables = wellVariables("bone");
    const dark = themeById("bone").dark;

    for (const [token, property] of Object.entries(CSS_VARIABLES) as Array<[keyof Palette, string]>) {
      expect(variables[property]).toBe(dark[token]);
    }
    // Custom properties only. A standard property in here would be silently dropped by React,
    // which spells those in camelCase and only routes a name starting with -- to setProperty.
    expect(Object.keys(variables).filter((name) => !name.startsWith("--"))).toEqual([]);
  });
});

describe("applying a palette", () => {
  it("writes every custom property CSS_VARIABLES names", () => {
    const target = styleTarget();
    const palette = themeById("jade").dark;

    applyPalette(target, palette, "dark");

    for (const [token, property] of Object.entries(CSS_VARIABLES) as Array<[keyof Palette, string]>) {
      expect(target.written.get(property)).toBe(palette[token]);
    }
  });

  it("sets color-scheme, so native controls and scrollbars match the rest", () => {
    // Without this a light theme keeps a dark scrollbar, a dark date picker and a dark select
    // popup, all of them drawn by the browser out of reach of any custom property.
    const target = styleTarget();
    applyPalette(target, themeById("bone").light, "light");
    expect(target.written.get("color-scheme")).toBe("light");
  });
});

describe("installing a theme", () => {
  it("paints once, immediately, so nothing waits for a media query event", () => {
    const target = styleTarget();
    installTheme(target, { paletteId: "ember", mode: "dark" }, schemeQuery(false));
    expect(target.written.get("--bg")).toBe(themeById("ember").dark.bg);
  });

  it("resolves system against the query it was handed", () => {
    const target = styleTarget();
    installTheme(target, { paletteId: "ember", mode: "system" }, schemeQuery(true));
    expect(target.written.get("--bg")).toBe(themeById("ember").dark.bg);
    expect(target.written.get("color-scheme")).toBe("dark");
  });

  it("re-applies when the OS preference changes while the mode is system", () => {
    const target = styleTarget();
    const query = schemeQuery(true);
    installTheme(target, { paletteId: "ember", mode: "system" }, query);

    query.matches = false;
    for (const listener of query.listeners) listener();

    expect(target.written.get("--bg")).toBe(themeById("ember").light.bg);
    expect(target.written.get("color-scheme")).toBe("light");
  });

  it("ignores the OS once somebody has chosen a mode outright", () => {
    const target = styleTarget();
    const query = schemeQuery(true);
    installTheme(target, { paletteId: "ember", mode: "light" }, query);

    query.matches = false;
    for (const listener of query.listeners) listener();

    expect(target.written.get("--bg")).toBe(themeById("ember").light.bg);
    expect(query.listeners.size).toBe(0);
  });

  it("unsubscribes on teardown, so a remount does not stack listeners", () => {
    const query = schemeQuery(false);
    const stop = installTheme(styleTarget(), { paletteId: "ember", mode: "system" }, query);
    expect(query.listeners.size).toBe(1);
    stop();
    expect(query.listeners.size).toBe(0);
  });

  it("still paints when there is no media query support at all", () => {
    // An embedded webview with no matchMedia is not a reason to render an unstyled page. System
    // means light there, which is the browser's own default when nobody has said anything.
    const target = styleTarget();
    const stop = installTheme(target, { paletteId: "ember", mode: "system" }, null);
    expect(target.written.get("--bg")).toBe(themeById("ember").light.bg);
    expect(() => stop()).not.toThrow();
  });

  it("survives a query that throws when subscribed to", () => {
    // Safari 13 and some webviews have matchMedia but not addEventListener on the result. The
    // theme is already painted by then, so the only thing lost is following the OS live.
    const target = styleTarget();
    const query: SchemeQuery = {
      matches: true,
      addEventListener() {
        throw new Error("no listener support");
      },
      removeEventListener() {
        throw new Error("no listener support");
      },
    };
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => installTheme(target, { paletteId: "ember", mode: "system" }, query)).not.toThrow();
    warn.mockRestore();
    expect(target.written.get("--bg")).toBe(themeById("ember").dark.bg);
  });
});
