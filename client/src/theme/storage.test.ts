// Reading a stored theme has to be TOTAL.
//
// Everything in here is a way the stored value can be something other than what was written:
// a browser that refuses storage, a key someone edited by hand, a palette that shipped once and
// was renamed, a half object. None of them is an error worth showing anyone, and every one of
// them has to end at a painted page rather than at a stack trace, because this runs on first
// paint before there is any interface to report a problem in.

import { describe, expect, it } from "vitest";

import type { WebStorage } from "../lib/browserStorage.js";
import { DEFAULT_THEME } from "./theme.js";
import { loadTheme, saveTheme, THEME_KEY } from "./storage.js";

function memoryStore(initial: Record<string, string> = {}): WebStorage & { data: Record<string, string> } {
  const data = { ...initial };
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

/** Safari in private browsing, an embedded webview, a user who blocked site data. */
const throwingStore: WebStorage = {
  getItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
  removeItem() {
    throw new Error("storage disabled");
  },
};

function stored(value: unknown): WebStorage {
  return memoryStore({ [THEME_KEY]: JSON.stringify(value) });
}

describe("loading the stored theme", () => {
  it("round trips a choice somebody actually made", () => {
    const store = memoryStore();
    saveTheme(store, { paletteId: "harbor", mode: "light" });
    expect(loadTheme(store)).toEqual({ paletteId: "harbor", mode: "light" });
  });

  it("falls back to the default when nothing has ever been stored", () => {
    expect(loadTheme(memoryStore())).toEqual(DEFAULT_THEME);
  });

  it("falls back to the default when there is no store at all", () => {
    expect(loadTheme(null)).toEqual(DEFAULT_THEME);
  });

  it("falls back to the default for text that is not JSON", () => {
    expect(loadTheme(memoryStore({ [THEME_KEY]: "{not json" }))).toEqual(DEFAULT_THEME);
  });

  it("falls back to the default for JSON that is not an object", () => {
    expect(loadTheme(stored("jade"))).toEqual(DEFAULT_THEME);
    expect(loadTheme(stored(null))).toEqual(DEFAULT_THEME);
    expect(loadTheme(stored([1, 2]))).toEqual(DEFAULT_THEME);
  });

  it("falls back to the default palette for an id that is no longer a theme", () => {
    // The renamed palette case. The mode beside it is still a perfectly good answer, so it is
    // kept: falling back field by field loses the least of what the person actually chose.
    expect(loadTheme(stored({ paletteId: "chartreuse", mode: "light" }))).toEqual({
      paletteId: DEFAULT_THEME.paletteId,
      mode: "light",
    });
  });

  it("falls back to the default mode for a mode it does not recognise", () => {
    expect(loadTheme(stored({ paletteId: "cocoa", mode: "sepia" }))).toEqual({
      paletteId: "cocoa",
      mode: DEFAULT_THEME.mode,
    });
  });

  it("does not propagate a store whose getter throws", () => {
    // The whole page renders off the back of this call. A throw here is a white screen.
    expect(() => loadTheme(throwingStore)).not.toThrow();
    expect(loadTheme(throwingStore)).toEqual(DEFAULT_THEME);
  });
});

describe("saving the theme", () => {
  it("does not propagate a store whose setter throws", () => {
    // Persisting is best effort. The choice still holds for this page's lifetime; it just will
    // not survive a reload, which is not worth interrupting a video call over.
    expect(() => saveTheme(throwingStore, { paletteId: "iris", mode: "dark" })).not.toThrow();
  });

  it("does nothing, quietly, when there is no store", () => {
    expect(() => saveTheme(null, { paletteId: "iris", mode: "dark" })).not.toThrow();
  });
});
