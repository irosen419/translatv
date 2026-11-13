// The stylesheet and the palette table have to stay one thing.
//
// Two ways they can come apart, and this suite exists for both:
//
//   A HARDCODED COLOUR. A hex written into a rule cannot be themed. It does not fail, it does not
//   warn, it just keeps painting the dark theme's colour in the light theme, and it is invisible
//   in review because a hex looks exactly as deliberate as a token does.
//
//   A STALE FALLBACK. The :root blocks hold the default theme inline so the first frame is
//   painted before any JavaScript runs. They are a hand copy of values that live in TypeScript,
//   which is precisely the kind of copy that goes quietly out of date the first time a palette
//   is touched.

import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CSS_VARIABLES, THEMES, type Palette } from "./palettes.js";
import { DEFAULT_THEME } from "./theme.js";

const CSS = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

/** Every .tsx under client/src, with its filename, for the source level guards below. */
function tsxSources(): { name: string; text: string }[] {
  const root = new URL("../", import.meta.url);
  const walk = (directory: URL): { name: string; text: string }[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
      if (entry.isDirectory()) return walk(child);
      return entry.name.endsWith(".tsx") ? [{ name: entry.name, text: readFileSync(child, "utf8") }] : [];
    });
  return walk(root);
}

/** Comments do not paint, so they are not part of what is being checked. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const ROOT_BLOCK = /:root\s*\{([^}]*)\}/g;

function rootBlocks(): string[] {
  return [...withoutComments(CSS).matchAll(ROOT_BLOCK)].map((match) => match[1]!);
}

function declarations(block: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const declaration of block.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const property = declaration.slice(0, colon).trim();
    const value = declaration.slice(colon + 1).trim();
    if (property && value) found.set(property, value);
  }
  return found;
}

const defaultTheme = THEMES.find((theme) => theme.id === DEFAULT_THEME.paletteId)!;
const TOKENS = Object.entries(CSS_VARIABLES) as Array<[keyof Palette, string]>;

describe("the pre JavaScript fallback in :root", () => {
  it("is exactly two blocks: the dark default, then the light one behind a media query", () => {
    expect(rootBlocks()).toHaveLength(2);
    expect(withoutComments(CSS)).toMatch(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{/);
  });

  it("paints the default theme's DARK half before any script has run", () => {
    const declared = declarations(rootBlocks()[0]!);
    for (const [token, property] of TOKENS) {
      expect(`${property}: ${declared.get(property)}`).toBe(
        `${property}: ${defaultTheme.dark[token]}`,
      );
    }
    expect(declared.get("color-scheme")).toBe("dark");
  });

  it("paints the default theme's LIGHT half when the OS asks for light", () => {
    // The default mode is system, so without this block every light mode reader would get a
    // dark flash on first paint and a repaint the moment the bundle finished loading.
    const declared = declarations(rootBlocks()[1]!);
    for (const [token, property] of TOKENS) {
      expect(`${property}: ${declared.get(property)}`).toBe(
        `${property}: ${defaultTheme.light[token]}`,
      );
    }
    expect(declared.get("color-scheme")).toBe("light");
  });
});

describe("the rest of the stylesheet", () => {
  /**
   * Everything outside the :root blocks, with comments dropped.
   *
   * The :root blocks are the one place a literal colour belongs, because they are the defaults
   * the custom properties themselves are being given.
   */
  function rules(): string {
    return withoutComments(CSS).replace(ROOT_BLOCK, "");
  }

  it("writes no raw HEX colour outside :root", () => {
    // The trailing guard keeps an id selector out of the results: #control-drawer is not a
    // colour, and the hyphen after the first six characters is what says so.
    //
    // Hex only, and the name of this test says so rather than promising that every rule can be
    // themed. It cannot see rgb(), rgba(), hsl(), color-mix() or a named colour, and five rules
    // do hardcode an rgba() foreground today: .subtitles .original and .original.live, .past-line,
    // .current-line .original and .interim-line. All five are white on the black scrim inside the
    // well, which is dark in every theme, so they are correct as written. Widening this guard
    // would fail on them and teach the next person to loosen it, which is worse than a narrow
    // guard that is honest about being narrow.
    const hits = rules().match(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g) ?? [];
    expect(hits).toEqual([]);
  });

  it("re-establishes the text colour on the video well", () => {
    // The well's custom properties inherit and are re-resolved wherever a var() reads them, but
    // `color` does not work that way. It inherits as an already COMPUTED value, so a descendant
    // with no colour rule of its own keeps whatever <body> resolved out of the page's palette,
    // and the inline custom properties never come into it. That is not hypothetical: the
    // translated subtitle line, which is the largest text on screen, has no colour rule.
    // Declaring it once on the well fixes every one of those descendants at a stroke.
    expect(rules()).toMatch(/\.video-area\s*\{[^}]*color:\s*var\(--text\)/);
  });

  it("still scrims the video with black rgba, which is theme independent on purpose", () => {
    // Those sit OVER video, and the video well is dark in every theme, so they are not a
    // tokenization the guard above is asking for.
    expect(rules()).toContain("rgba(0, 0, 0,");
  });

  it("names no token the palette table does not define", () => {
    const declared = new Set(
      [...rules().matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]!),
    );
    // --radius and the drawer's four are NOT palette tokens and are not meant to be. This
    // guard exists to catch a misspelled colour, since var(--surfce) paints nothing and says
    // nothing, so a measurement no theme could ever define is named here rather than being
    // tokenized into a palette it has no business in. The drawer's four are one piece of
    // arithmetic shared by two rules: the height of the gear's tab, and how far short of the
    // bottom the shut dock stops, which have to be the same number or the gear moves.
    const known = new Set<string>([
      ...Object.values(CSS_VARIABLES),
      "--radius",
      "--gear-size",
      "--gear-inset",
      "--gear-tab-pad",
      "--drawer-handle-height",
    ]);
    expect([...declared].filter((token) => !known.has(token))).toEqual([]);
  });

  it("has no trace of the tokens this replaced", () => {
    // --panel and --panel-2 became --surface and --surface-2. --ok is gone outright: the on
    // state is the accent now, and the off state is --muted.
    expect(rules()).not.toMatch(/var\(\s*--panel/);
    expect(rules()).not.toMatch(/var\(\s*--ok\b/);
  });
});

/**
 * The same two rules, applied to the components.
 *
 * The stylesheet is not the only place a colour can be written down: a handful of components
 * carry an inline `style` with custom properties in it, and one of them had a pair of raw hexes
 * that were only ever right in the old dark only app. A renamed token in an inline style is the
 * quieter of the two failures, because `var(--panel-2)` does not error, it paints nothing.
 */
describe("the components", () => {
  function componentSources(): string[] {
    const root = new URL("../", import.meta.url);
    const walk = (directory: URL): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
        if (entry.isDirectory()) return walk(child);
        return entry.name.endsWith(".tsx") ? [readFileSync(child, "utf8")] : [];
      });
    return walk(root);
  }

  it("write no raw hex colour into an inline style", () => {
    const hits = componentSources().flatMap(
      (source) => source.match(/#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])/g) ?? [],
    );
    expect(hits).toEqual([]);
  });

  it("name no token the palette table does not define", () => {
    const known = new Set<string>([...Object.values(CSS_VARIABLES), "--radius"]);
    const used = new Set(
      componentSources().flatMap((source) =>
        [...source.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((match) => match[1]!),
      ),
    );
    expect([...used].filter((token) => !known.has(token))).toEqual([]);
  });
});

/**
 * The well's dark palette actually reaches the well.
 *
 * Two halves of this rule were already tested and the join between them was not. `wellPalette`
 * returning the dark half is checked in theme.test.ts, the dark half's foregrounds clearing AA
 * on the well is checked in palettes.test.ts, and the stylesheet naming `.video-area` is checked
 * above. None of that notices if the style stops reaching the element: deleting `style={...}`
 * from the well leaves all 460 client tests green, and every light theme user then reads page
 * ink over a dark well at 1.04:1.
 *
 * That join is one JSX attribute, so this reads the source for it. A behavioural test would need
 * to render Room, which needs a DOM and a store this suite deliberately does without, and the
 * precedent here is already to assert source contents: the stylesheet guards above do it.
 *
 * Moving the well into its own component is fine and will fail here, loudly, with the attribute
 * named. That is the intent. The failure mode this exists for is exactly a refactor that carries
 * the element somewhere else and leaves the style behind.
 */
describe("the video well", () => {
  /** Every opening tag carrying `className="video-area"`, with the file it came from. */
  const wells = tsxSources().flatMap(({ name, text }) =>
    [...text.matchAll(/<[a-zA-Z][^>]*className="video-area"[^>]*>/g)].map((match) => ({
      name,
      text,
      tag: match[0],
    })),
  );

  it("is drawn exactly once, so there is one place for this rule to hold", () => {
    expect(
      wells.map((well) => well.name),
      "a second well would need the dark palette too, and this guard only checks the ones it finds",
    ).toHaveLength(1);
  });

  it("carries an inline style on the element itself", () => {
    for (const well of wells) {
      expect(
        well.tag,
        "the well takes the theme's dark half as inline custom properties, and without the attribute it inherits the page's instead",
      ).toMatch(/\sstyle=\{/);
    }
  });

  it("binds that style to the well palette rather than to some other object", () => {
    for (const well of wells) {
      // The hook may be imported under another name, so resolve an alias before blaming the
      // binding. Saying "x is not the output of useVideoWellStyle" when it is, via an alias,
      // sends whoever reads it looking in the wrong place.
      const alias = /useVideoWellStyle\s+as\s+([A-Za-z_$][\w$]*)/.exec(well.text)?.[1];
      const hook = alias ?? "useVideoWellStyle";
      const fromHook = (name: string): boolean =>
        new RegExp(`\\b${name}\\s*=\\s*${hook}\\(\\)`).test(well.text);

      // Every identifier the style could be coming from, not just the first one after the
      // brace. `style={x}` is one candidate; `style={{ ...x, y: 1 }}` and `style={{ y: 1, ...x }}`
      // are the same edit written two ways, and an earlier version of this anchored on whatever
      // came first, so putting the spread second made it demand that `y` be the hook. Adding one
      // property to this style is the likeliest honest edit to the element, and a guard that
      // reddens on it is one somebody deletes rather than widens.
      const direct = /\sstyle=\{([A-Za-z_$][\w$]*)\}/.exec(well.tag)?.[1];
      const group = /\sstyle=\{\{([\s\S]*)\}\}/.exec(well.tag)?.[1] ?? "";
      const spreads = [...group.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1]!);
      const candidates = direct !== undefined ? [direct, ...spreads] : spreads;

      expect(
        candidates,
        `the well in ${well.name} sets style from an expression this guard cannot follow, so widen it rather than deleting it`,
      ).not.toHaveLength(0);
      expect(
        candidates.some(fromHook),
        `none of ${candidates.map((name) => `"${name}"`).join(", ")} is the output of ${hook}, so the well is painted from something else`,
      ).toBe(true);
    }
  });
});

/**
 * The marker that says a translation is missing carries WORDS, not just a colour.
 *
 * This is the stated mitigation for the one accessibility limit this theme table cannot design
 * away: on three light halves the accent and the warn hue sit close enough under a dichromat
 * simulation to be hard to tell apart, and the answer is that the marker never relies on its
 * hue, because it also says "not translated". That answer was verified by reading and by
 * nothing else, so a refactor reducing the marker to a coloured dot would have taken the
 * mitigation with it and left the reasoning in the pull request standing over nothing.
 *
 * The key is asserted, not the English. Copy belongs to the copy files and check:copy already
 * guards that every language has it.
 */
describe("the not translated marker", () => {
  // No bound on the span body. An earlier version capped it at 400 characters, which meant a
  // marker that grew past the cap silently stopped being found: the count assertion below would
  // fail and point at the overlays, when the real problem was this regex.
  const markers = tsxSources().flatMap(({ name, text }) =>
    [...text.matchAll(/<span\s[^>]*className="marker"[\s\S]*?<\/span>/g)].map((match) => ({
      name,
      markup: match[0],
    })),
  );

  it("is drawn somewhere, so this suite is not quietly asserting nothing", () => {
    expect(
      markers.map((marker) => marker.name),
      "no element carries className=\"marker\" any more, so the guard below has nothing to check",
    ).not.toHaveLength(0);
  });

  it("says so in words, so its hue is never the only thing carrying it", () => {
    for (const marker of markers) {
      expect(
        marker.markup,
        `the marker in ${marker.name} has lost its text, which leaves colour alone to say a line was not translated`,
      ).toContain('copy.t("caption.notTranslated")');
    }
  });

  /**
   * Both overlays still reach a marker, by drawing one or by rendering something that does.
   *
   * Pinning the two FILENAMES was wrong and this replaces it. Extracting a shared marker
   * component is a refactor somebody will plausibly do, it is arguably better code, and it made
   * the old assertion fail while the thing it guards was perfectly intact. A guard that fails on
   * correct code is one that gets deleted rather than understood, which is exactly how the rule
   * it protects goes missing.
   */
  it("is reachable from both the subtitles and the conversation log", () => {
    // Matched by the MODULE a marker lives in, not by the component's name. A file named
    // Marker.tsx can export NotTranslatedMarker, so deriving a tag name from the filename finds
    // nothing and blames the overlay for a guess this guard got wrong.
    const drawing = new Set(markers.map((marker) => marker.name.replace(/\.tsx$/, "")));
    for (const overlay of ["SubtitleOverlay", "ConversationOverlay"]) {
      const source = tsxSources().find((file) => file.name === `${overlay}.tsx`);
      expect(source, `${overlay}.tsx has gone, so this guard no longer knows where to look`).toBeDefined();
      const reaches =
        drawing.has(overlay) ||
        [...drawing].some((module) =>
          // Any extension, because this repo imports components as `.jsx` and an earlier
          // version of this accepted only `.js`, which is the one form the codebase never
          // writes. The guard then failed on the in house way of doing the very refactor it
          // was widened to allow.
          new RegExp(`from\\s+"[^"]*\\b${module}(\\.[jt]sx?)?"`).test(source?.text ?? ""),
        );
      expect(
        reaches,
        `${overlay} neither draws the not translated marker nor imports a module that does`,
      ).toBe(true);
    }
  });
});
