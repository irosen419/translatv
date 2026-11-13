/**
 * The ten palettes, each a matched light and dark pair.
 *
 * These values come from the colour study at
 * https://claude.ai/artifact/EeJDER1PWDmkM1wtwTt21M and are not arbitrary: every text pair in
 * every theme clears WCAG AA against the surface it actually sits on, and the accent, warn and
 * danger tones were checked against simulated deuteranopia and protanopia so the three semantic
 * colours stay distinguishable. Changing one value here is a design change, not a tweak, so
 * re-measure rather than eyeballing it.
 *
 * Two rules hold across every palette:
 *   - `stage` and `frame` stay dark in BOTH modes. The video well surrounds a photograph, and a
 *     bright surround is glare. A light theme lightens the chrome, never the well.
 *   - The on state is the accent and the off state is `muted`. Presence of colour means on. That
 *     replaces the old green against red pair, which is the one pairing red green colour
 *     blindness collapses.
 */

/** Every token a theme must define. Each one maps to the CSS custom property named beside it. */
export interface Palette {
  /** --bg, the app ground */
  bg: string;
  /** --surface, top bar, transcript panel, bottom bar */
  surface: string;
  /** --surface-2, inputs, code badge, small buttons */
  surface2: string;
  /** --line, every hairline */
  line: string;
  /** --stage, the video well. Dark in both modes. */
  stage: string;
  /** --frame, the video rectangle itself. Dark in both modes. */
  frame: string;
  /** --text */
  text: string;
  /** --muted, status text, the untranslated original, and the off state */
  muted: string;
  /** --accent, brand, speaker name, and the on state */
  accent: string;
  /** --accent-fill, filled buttons */
  accentFill: string;
  /** --accent-ink, text sitting on a filled accent */
  accentInk: string;
  /** --accent-quiet, accent borders */
  accentQuiet: string;
  /** --accent-wash, accent backgrounds */
  accentWash: string;
  /** --warn, the not translated marker and notices */
  warn: string;
  /** --warn-quiet */
  warnQuiet: string;
  /** --warn-wash */
  warnWash: string;
  /** --danger, destructive only */
  danger: string;
  /** --danger-quiet */
  dangerQuiet: string;
  /** --danger-wash */
  dangerWash: string;
}

/** The CSS custom property each palette key is written to. */
export const CSS_VARIABLES: Readonly<Record<keyof Palette, string>> = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  line: "--line",
  stage: "--stage",
  frame: "--frame",
  text: "--text",
  muted: "--muted",
  accent: "--accent",
  accentFill: "--accent-fill",
  accentInk: "--accent-ink",
  accentQuiet: "--accent-quiet",
  accentWash: "--accent-wash",
  warn: "--warn",
  warnQuiet: "--warn-quiet",
  warnWash: "--warn-wash",
  danger: "--danger",
  dangerQuiet: "--danger-quiet",
  dangerWash: "--danger-wash",
};

export type PaletteId =
  | "ember"
  | "signal"
  | "jade"
  | "iris"
  | "harbor"
  | "graphite"
  | "rosewood"
  | "bone"
  | "ultramarine"
  | "cocoa"
  ;

export interface ThemeDefinition {
  id: PaletteId;
  /** Shown in the picker. A proper noun, so it is NOT translated. */
  name: string;
  light: Palette;
  dark: Palette;
}

export const THEMES: readonly ThemeDefinition[] = [
  {
    id: "ember",
    name: "Ember",
    light: {
      bg: "#faf6f0",
      surface: "#ffffff",
      surface2: "#f1ebe2",
      line: "#e0d7ca",
      stage: "#17130f",
      frame: "#2a2420",
      text: "#1e1914",
      muted: "#6b6053",
      accent: "#ad4a18",
      accentFill: "#c0551d",
      accentInk: "#ffffff",
      accentQuiet: "#e3c1a3",
      accentWash: "#fbede1",
      warn: "#7e5a08",
      warnQuiet: "#dcc28a",
      warnWash: "#fbf2de",
      danger: "#ad2e25",
      dangerQuiet: "#ebbbb5",
      dangerWash: "#fbebea",
    },
    dark: {
      bg: "#100d0b",
      surface: "#1a1613",
      surface2: "#241f1a",
      line: "#342d26",
      stage: "#080706",
      frame: "#1c1916",
      text: "#f4efe8",
      muted: "#aba093",
      accent: "#f07c43",
      accentFill: "#f07c43",
      accentInk: "#24120a",
      accentQuiet: "#563018",
      accentWash: "#251710",
      warn: "#edcd82",
      warnQuiet: "#544425",
      warnWash: "#251d0f",
      danger: "#f0685c",
      dangerQuiet: "#562822",
      dangerWash: "#261412",
    },
  },
  {
    id: "signal",
    name: "Signal",
    light: {
      bg: "#f6f8fb",
      surface: "#ffffff",
      surface2: "#edf1f6",
      line: "#d8e0ea",
      stage: "#0e141b",
      frame: "#222c38",
      text: "#131920",
      muted: "#5c6b7c",
      accent: "#1263a8",
      accentFill: "#1571bf",
      accentInk: "#ffffff",
      accentQuiet: "#a9c8e4",
      accentWash: "#e7f1fa",
      warn: "#84590a",
      warnQuiet: "#dcc28a",
      warnWash: "#fbf2de",
      danger: "#af3128",
      dangerQuiet: "#ebbdb8",
      dangerWash: "#fbeceb",
    },
    dark: {
      bg: "#0c0f14",
      surface: "#141a22",
      surface2: "#1c242e",
      line: "#2a3542",
      stage: "#05070a",
      frame: "#161d26",
      text: "#e8eef5",
      muted: "#93a2b4",
      accent: "#5aaef5",
      accentFill: "#5aaef5",
      accentInk: "#04182b",
      accentQuiet: "#20455f",
      accentWash: "#0f1e2c",
      warn: "#f0a93c",
      warnQuiet: "#503818",
      warnWash: "#241b0f",
      danger: "#f07e72",
      dangerQuiet: "#542c27",
      dangerWash: "#251513",
    },
  },
  {
    id: "jade",
    name: "Jade",
    light: {
      bg: "#f5f8f6",
      surface: "#ffffff",
      surface2: "#eaf0ed",
      line: "#d5e0db",
      stage: "#0b1210",
      frame: "#1f2a26",
      text: "#121a17",
      muted: "#5a6b65",
      accent: "#0a7355",
      accentFill: "#0b815f",
      accentInk: "#ffffff",
      accentQuiet: "#a3d2c1",
      accentWash: "#e5f4ee",
      warn: "#78550a",
      warnQuiet: "#dbc189",
      warnWash: "#faf1dd",
      danger: "#ab2f27",
      dangerQuiet: "#eabcb7",
      dangerWash: "#faebea",
    },
    dark: {
      bg: "#0a0e0d",
      surface: "#131a18",
      surface2: "#1b2421",
      line: "#283430",
      stage: "#050807",
      frame: "#151d1a",
      text: "#e9f0ed",
      muted: "#93a49e",
      accent: "#46d6a4",
      accentFill: "#46d6a4",
      accentInk: "#03251a",
      accentQuiet: "#1a5142",
      accentWash: "#0d211b",
      warn: "#e8bc57",
      warnQuiet: "#4c3a1c",
      warnWash: "#231c10",
      danger: "#f07a6e",
      dangerQuiet: "#532a26",
      dangerWash: "#241413",
    },
  },
  {
    id: "iris",
    name: "Iris",
    light: {
      bg: "#f8f6fd",
      surface: "#ffffff",
      surface2: "#eeebf8",
      line: "#dcd7ee",
      stage: "#131028",
      frame: "#272240",
      text: "#17142a",
      muted: "#5d5878",
      accent: "#5645b8",
      accentFill: "#6152c4",
      accentInk: "#ffffff",
      accentQuiet: "#c0b6ec",
      accentWash: "#eeeafb",
      warn: "#7c5709",
      warnQuiet: "#dcc188",
      warnWash: "#faf1dd",
      danger: "#ac2a48",
      dangerQuiet: "#ebb8c4",
      dangerWash: "#fbebee",
    },
    dark: {
      bg: "#0e0c16",
      surface: "#171426",
      surface2: "#201c33",
      line: "#2e2947",
      stage: "#07060d",
      frame: "#18152a",
      text: "#edebf7",
      muted: "#a6a1c2",
      accent: "#a99bf5",
      accentFill: "#a99bf5",
      accentInk: "#16103a",
      accentQuiet: "#413878",
      accentWash: "#161230",
      warn: "#efb960",
      warnQuiet: "#4e3e22",
      warnWash: "#231c10",
      danger: "#f0778f",
      dangerQuiet: "#5a2938",
      dangerWash: "#241017",
    },
  },
  {
    id: "harbor",
    name: "Harbor",
    light: {
      bg: "#f3f8f9",
      surface: "#ffffff",
      surface2: "#e8f0f2",
      line: "#d2e1e4",
      stage: "#0a171a",
      frame: "#1e3239",
      text: "#0f1c20",
      muted: "#506267",
      accent: "#8f4e0b",
      accentFill: "#a25a10",
      accentInk: "#ffffff",
      accentQuiet: "#e0c09a",
      accentWash: "#fbf0e3",
      warn: "#6c5205",
      warnQuiet: "#d9c286",
      warnWash: "#f9f2dc",
      danger: "#a72f27",
      dangerQuiet: "#e9bcb7",
      dangerWash: "#faebea",
    },
    dark: {
      bg: "#081114",
      surface: "#101d22",
      surface2: "#17272d",
      line: "#23393f",
      stage: "#040c0e",
      frame: "#122126",
      text: "#e6eff1",
      muted: "#94aab0",
      accent: "#f2b277",
      accentFill: "#f2b277",
      accentInk: "#291505",
      accentQuiet: "#5e4025",
      accentWash: "#22160d",
      warn: "#e2af36",
      warnQuiet: "#4e3c1c",
      warnWash: "#211e0f",
      danger: "#f08a80",
      dangerQuiet: "#5a302b",
      dangerWash: "#241413",
    },
  },
  {
    id: "graphite",
    name: "Graphite",
    light: {
      bg: "#f7f7f7",
      surface: "#ffffff",
      surface2: "#ededed",
      line: "#dcdcdc",
      stage: "#121212",
      frame: "#272727",
      text: "#151515",
      muted: "#5c5c5c",
      accent: "#4c5e07",
      accentFill: "#57690b",
      accentInk: "#ffffff",
      accentQuiet: "#c4d488",
      accentWash: "#f1f6de",
      warn: "#745105",
      warnQuiet: "#d9c086",
      warnWash: "#f9f1db",
      danger: "#a92d25",
      dangerQuiet: "#e9bbb6",
      dangerWash: "#faeae9",
    },
    dark: {
      bg: "#0e0e0e",
      surface: "#181818",
      surface2: "#222222",
      line: "#323232",
      stage: "#050505",
      frame: "#1a1a1a",
      text: "#efefef",
      muted: "#a4a4a4",
      accent: "#c6f04a",
      accentFill: "#c6f04a",
      accentInk: "#1c2405",
      accentQuiet: "#505e24",
      accentWash: "#191c0e",
      warn: "#e9c267",
      warnQuiet: "#524425",
      warnWash: "#231b0e",
      danger: "#f08279",
      dangerQuiet: "#55302c",
      dangerWash: "#231413",
    },
  },
  {
    id: "rosewood",
    name: "Rosewood",
    light: {
      bg: "#fbf6f8",
      surface: "#ffffff",
      surface2: "#f3eaee",
      line: "#e5d6dd",
      stage: "#170d12",
      frame: "#2c1f25",
      text: "#221419",
      muted: "#6e5a62",
      accent: "#a33a57",
      accentFill: "#b44262",
      accentInk: "#ffffff",
      accentQuiet: "#e6bcc8",
      accentWash: "#fbedf1",
      warn: "#785509",
      warnQuiet: "#dabf85",
      warnWash: "#f9f1dc",
      danger: "#9e2b20",
      dangerQuiet: "#e7b9b3",
      dangerWash: "#faeae8",
    },
    dark: {
      bg: "#130a10",
      surface: "#1e1119",
      surface2: "#291822",
      line: "#3a2332",
      stage: "#0a0507",
      frame: "#1f1219",
      text: "#f4eaef",
      muted: "#b8a2ae",
      accent: "#f0a0b4",
      accentFill: "#f0a0b4",
      accentInk: "#2e0e1a",
      accentQuiet: "#62303f",
      accentWash: "#260f18",
      warn: "#e8be68",
      warnQuiet: "#503e22",
      warnWash: "#231c10",
      danger: "#e45b52",
      dangerQuiet: "#5a2823",
      dangerWash: "#271312",
    },
  },
  {
    id: "bone",
    name: "Bone",
    light: {
      bg: "#f7f3ea",
      surface: "#fffdf8",
      surface2: "#eee8da",
      line: "#ddd4c2",
      stage: "#181611",
      frame: "#2b2822",
      text: "#1c1a14",
      muted: "#68624f",
      accent: "#2f4a9e",
      accentFill: "#35539e",
      accentInk: "#ffffff",
      accentQuiet: "#b3c1e4",
      accentWash: "#e9edf9",
      warn: "#7a5605",
      warnQuiet: "#d9c086",
      warnWash: "#f9f1db",
      danger: "#a62f26",
      dangerQuiet: "#e8bbb5",
      dangerWash: "#f9eae8",
    },
    dark: {
      bg: "#100f0c",
      surface: "#1a1815",
      surface2: "#24221e",
      line: "#34312b",
      stage: "#070605",
      frame: "#1c1a17",
      text: "#f2efe8",
      muted: "#aba598",
      accent: "#9bb2f0",
      accentFill: "#9bb2f0",
      accentInk: "#0c1734",
      accentQuiet: "#39456b",
      accentWash: "#121627",
      warn: "#e8be68",
      warnQuiet: "#4e3e22",
      warnWash: "#231c10",
      danger: "#ee7e72",
      dangerQuiet: "#553029",
      dangerWash: "#251413",
    },
  },
  {
    id: "ultramarine",
    name: "Ultramarine",
    light: {
      bg: "#f4f5fc",
      surface: "#ffffff",
      surface2: "#e9ecf8",
      line: "#d3d8ee",
      stage: "#0a0e24",
      frame: "#1e2549",
      text: "#111533",
      muted: "#575f87",
      accent: "#8a5a05",
      accentFill: "#9c6608",
      accentInk: "#ffffff",
      accentQuiet: "#e0c594",
      accentWash: "#faf2e1",
      warn: "#125c80",
      warnQuiet: "#a8ccde",
      warnWash: "#e6f2f8",
      danger: "#ac2f36",
      dangerQuiet: "#e9babd",
      dangerWash: "#faeaeb",
    },
    dark: {
      bg: "#080c22",
      surface: "#101634",
      surface2: "#171f45",
      line: "#252f5e",
      stage: "#040613",
      frame: "#111739",
      text: "#e7ebfa",
      muted: "#9aa3cc",
      accent: "#f5c15c",
      accentFill: "#f5c15c",
      accentInk: "#2b1d03",
      accentQuiet: "#5b4620",
      accentWash: "#1e1a1a",
      warn: "#8fd4f5",
      warnQuiet: "#27465a",
      warnWash: "#0f1c24",
      danger: "#f58787",
      dangerQuiet: "#5c2e32",
      dangerWash: "#261417",
    },
  },
  {
    id: "cocoa",
    name: "Cocoa",
    light: {
      bg: "#f9f5f0",
      surface: "#ffffff",
      surface2: "#f0e9e1",
      line: "#dfd5c9",
      stage: "#151009",
      frame: "#2a231c",
      text: "#1f1811",
      muted: "#6d6153",
      accent: "#1a5e85",
      accentFill: "#1d6b97",
      accentInk: "#ffffff",
      accentQuiet: "#afcee1",
      accentWash: "#e8f2f8",
      warn: "#7c5808",
      warnQuiet: "#dbc188",
      warnWash: "#faf1dd",
      danger: "#ab2f26",
      dangerQuiet: "#e9bbb5",
      dangerWash: "#faeae9",
    },
    dark: {
      bg: "#120e0b",
      surface: "#1d1713",
      surface2: "#28211b",
      line: "#392f27",
      stage: "#090706",
      frame: "#1e1814",
      text: "#f3ede6",
      muted: "#b0a395",
      accent: "#8fc4e8",
      accentFill: "#8fc4e8",
      accentInk: "#0a1f2e",
      accentQuiet: "#33505f",
      accentWash: "#111a20",
      warn: "#ebba52",
      warnQuiet: "#503e22",
      warnWash: "#251d0f",
      danger: "#f08278",
      dangerQuiet: "#59302b",
      dangerWash: "#261513",
    },
  },
];

/**
 * Bone, because it is the one palette in the set drawn light first.
 *
 * There is very little chroma anywhere in it, which is what lets the same theme hold up in a
 * bright room and in a dark one rather than being a dark theme with a light mode bolted on.
 */
export const DEFAULT_PALETTE_ID: PaletteId = "bone";
