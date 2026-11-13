import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

// Comments are blanked rather than removed so every offset below still points at the real file,
// and so a rule sitting under a comment block is still preceded by the `}` the parser anchors on.
// Without this, the long comment above `.stage` hid that rule from the parser entirely and the
// suite passed while the bug was still there.
const css = source.replace(/\/\*[\s\S]*?\*\//g, (match) => " ".repeat(match.length));

/**
 * A `@media` query adds NO specificity. So a reduced motion rule only wins if it appears after
 * the rule it overrides, and a reduced motion block written above its own targets is silently
 * dead: it parses, it matches, and it loses. That shipped once in this file, where the drawer's
 * `transition: none` sat 200 lines above the drawer itself and a reduced motion user got the
 * full slide anyway.
 *
 * The check is per SELECTOR AND PROPERTY, not per selector. A later rule that sets `right` on a
 * selector whose animation was killed earlier is not a conflict, and treating it as one would
 * make this suite fail on layout edits that have nothing to do with motion.
 *
 * Source positions are read rather than a rendered style, because the failure is a property OF
 * THE FILE. Seeing it in jsdom would need a real cascade implementation, which jsdom lacks.
 *
 * KNOWN LIMITATION, left open deliberately. Selectors are compared as normalized strings, and a
 * comma inside `:is()` or `:where()` would split into fragments that match nothing, so a later
 * `:is(.stage, .room) { transition: ... }` would defeat a guarded rule without failing here.
 * Closing it needs specificity arithmetic over a real selector parser. There is no `:is()` in
 * this file, so it is latent; if one arrives, this needs to grow rather than be trusted.
 */
type Rule = { start: number; selectors: string[]; properties: Set<string> };

/**
 * A combinator is the same combinator whatever surrounds it, so `a>b` and `a > b` are compared
 * equal. Selectors are matched as STRINGS here, and without this a reformat would quietly stop a
 * rule being guarded while looking like no change at all.
 */
function normalizeSelector(selector: string): string {
  return selector.replace(/\s*([>+~])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
}

/**
 * `transition: none` is defeated by a later `transition-property` AND `transition-duration`
 * pair, but NOT by either longhand alone: measured in Chromium, a lone duration leaves the
 * property at `none` and a lone property leaves the duration at 0s, so neither animates. Only
 * the pair does. So a shorthand in the override is treated as also owning that pair.
 */
const SHORTHAND_PAIRS: Record<string, string[]> = {
  transition: ["transition-property", "transition-duration"],
  animation: ["animation-name", "animation-duration"],
};

function defeats(basePropertes: Set<string>, property: string): boolean {
  if (basePropertes.has(property)) return true;
  const pair = SHORTHAND_PAIRS[property];
  return pair !== undefined && pair.every((longhand) => basePropertes.has(longhand));
}

/**
 * One rule: its selector list and its body.
 *
 * The delimiter is a LOOKBEHIND, not a captured group. Consuming it meant each match ate the
 * previous rule's closing brace, so consecutive rules parsed alternately: the grouped `.stage`
 * rule was skipped entirely and this suite passed over the very bug it exists to catch.
 *
 * Shared by both readers of this file rather than written out twice. matchAll works from a copy
 * of the regex, so the two never see each other's position.
 */
const RULE_PATTERN = /(?:^|(?<=[};{]))\s*([^{}@;]+?)\s*\{([^{}]*)\}/gm;

function parseRules(text: string, offset: number): Rule[] {
  const rules: Rule[] = [];
  for (const match of text.matchAll(RULE_PATTERN)) {
    const properties = new Set<string>();
    for (const declaration of (match[2] ?? "").split(";")) {
      const name = declaration.split(":")[0]?.trim().toLowerCase();
      if (name && !name.startsWith("/*")) properties.add(name);
    }
    rules.push({
      start: offset + (match.index ?? 0),
      selectors: (match[1] ?? "").split(",").map(normalizeSelector).filter(Boolean),
      properties,
    });
  }
  return rules;
}

function reducedMotionBlocks(): { start: number; bodyStart: number; body: string }[] {
  const blocks: { start: number; bodyStart: number; body: string }[] = [];
  for (const match of css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{/g)) {
    const start = match.index ?? 0;
    let depth = 1;
    let i = start + match[0].length;
    const bodyStart = i;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      i += 1;
    }
    blocks.push({ start, bodyStart, body: css.slice(bodyStart, i - 1) });
  }
  return blocks;
}

const blocks = reducedMotionBlocks();
// Rules NOT inside any reduced motion block. A block's own rules cannot lose to themselves, and
// including them would compare a block against itself.
// Ranged on bodyStart, NOT start. `start` points at the `@media` keyword and the body begins 41
// characters later, so ranging on it shifted every exclusion left by 41 and left the last 41
// characters of every block unfiltered, to be compared against the block containing them. The
// file passed by about one character of margin: moving this PR's own `.gear-button` rule from
// the top of its block to the bottom, semantically identical CSS, turned the suite red.
const blockRanges = blocks.map((b) => [b.bodyStart, b.bodyStart + b.body.length] as const);
const baseRules = parseRules(css, 0).filter(
  (rule) => !blockRanges.some(([from, to]) => rule.start >= from && rule.start <= to),
);

describe("reduced motion rules are positioned to win", () => {
  it("finds the reduced motion blocks, so a rename cannot silently empty this suite", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("finds ordinary rules to compare them against", () => {
    expect(baseRules.length).toBeGreaterThan(20);
  });

  it("does not mistake a reduced motion rule for an ordinary one, at any position in its block", () => {
    const leaked = baseRules.filter((rule) =>
      blocks.some((block) => rule.start > block.start && rule.start < block.bodyStart + block.body.length),
    );
    expect(
      leaked.map((rule) => `${rule.selectors.join(", ")} @ ${rule.start}`),
      "these rules are INSIDE a reduced motion block but are being treated as ordinary rules, so the block is being compared against itself",
    ).toEqual([]);
  });

  for (const block of blocks) {
    for (const rule of parseRules(block.body, block.start)) {
      for (const selector of rule.selectors) {
        for (const property of rule.properties) {
          it(`"${selector}" { ${property} } is overridden after it is set, not before`, () => {
            const losingTo = baseRules.filter(
              (base) =>
                base.start > block.start &&
                base.selectors.includes(selector) &&
                defeats(base.properties, property),
            );
            expect(
              losingTo.map((base) => base.start),
              `the reduced motion rule for "${selector}" at offset ${block.start} sets ${property}, but ordinary rules at these offsets set it again LATER at the same specificity, so the reduced motion value never applies`,
            ).toEqual([]);
          });
        }
      }
    }
  }
});

/**
 * The self view control row: two icon buttons and a level meter, inside a stack that is a fixed
 * 168px wide (108px on an upright phone).
 *
 * This guard used to do arithmetic on MEASURED LABEL WIDTHS. The buttons held text ("Mute",
 * "Cámara no"), a stylesheet cannot lay out text, and the row's whole fragility came from not
 * knowing how wide its own contents were in the reader's language. The buttons are icons now, so
 * the width is DECLARED in the stylesheet rather than discovered by a font. The measurements,
 * the font variance allowance and the per language arithmetic went with the text they described:
 * an icon is the same width in every language, which is the point of that change.
 *
 * Three things are pinned below.
 *
 *   1. THE ROW FITS. Both buttons, both gaps and the meter's floor inside the NARROWEST stack.
 *      The bug this inherits: a wrapping flex container collects items onto lines by their
 *      HYPOTHETICAL main size, which is the flex basis clamped up by min-width, and NOT by the
 *      size they would shrink to. So the meter's floor is what wraps the row, and shrinking
 *      never gets its turn. Lowering only one of the two leaves the bug where it was.
 *   2. THE TOUCH TARGETS. These two are the one control that has to work on a phone in one tap,
 *      and a 26px button is not a tap target. The ::after pseudo element carries the 44px, and
 *      the two of them must not reach each other, because the later one in the DOM would take
 *      taps aimed at the earlier one.
 *   3. THE METER STAYS VISIBLE at its floor and grows back. It is how you see you are still hot.
 *
 * The wrap is still declared and check 1 now says nothing can reach it. That is deliberate, and
 * the reasoning is in styles.css beside the rule.
 */

/** Every published minimum touch target agrees on this, and a phone is the point of this row. */
const MIN_TOUCH_TARGET_PX = 44;

/**
 * Every rule in the file, in source order, parsed ONCE.
 *
 * It used to be a fresh scan per lookup. The variable width lookbehind costs about a second
 * over a file this size, so the suite's runtime grew by that much with every guard added, for
 * the same parse repeated. Nothing about the answers changes: the order below is the order the
 * scan produced, which is what makes "in source order" still true of the lookups.
 */
const DECLARATIONS: ReadonlyArray<{ selectors: string[]; body: string }> = [
  ...css.matchAll(RULE_PATTERN),
].map((match) => ({
  selectors: (match[1] ?? "").split(",").map(normalizeSelector),
  body: match[2] ?? "",
}));

/** Every value this selector sets for this property, in source order, across media queries too. */
function declaredValues(selector: string, property: string): string[] {
  const wanted = normalizeSelector(selector);
  const values: string[] = [];
  for (const rule of DECLARATIONS) {
    if (!rule.selectors.includes(wanted)) continue;
    for (const declaration of rule.body.split(";")) {
      const separator = declaration.indexOf(":");
      if (separator < 0) continue;
      if (declaration.slice(0, separator).trim().toLowerCase() !== property) continue;
      values.push(declaration.slice(separator + 1).trim());
    }
  }
  return values;
}

/** The one value this selector sets for this property, or a failure naming what went missing. */
function declaredValue(selector: string, property: string): string {
  const values = declaredValues(selector, property);
  expect(values, `expected exactly one "${property}" on "${selector}" in styles.css`).toHaveLength(1);
  return values[0] as string;
}

function pixels(value: string, source: string): number {
  const match = /^(\d+(?:\.\d+)?)px$/.exec(value);
  expect(match, `${source} is "${value}", which this guard cannot read as a px length`).not.toBeNull();
  return Number(match?.[1]);
}

/** grow, shrink and basis out of a three value `flex` shorthand, which is the only form used here. */
function flexParts(shorthand: string, source: string): { grow: number; shrink: number; basis: string } {
  const parts = shorthand.split(/\s+/);
  expect(
    parts,
    `${source} is "${shorthand}". This guard only reads the three value form, "grow shrink basis". Teach it the new form rather than deleting the check.`,
  ).toHaveLength(3);
  return { grow: Number(parts[0]), shrink: Number(parts[1]), basis: parts[2] as string };
}

describe("the self view control row", () => {
  const buttonWidth = pixels(declaredValue(".self-control", "width"), ".self-control width");
  const buttonHeight = pixels(declaredValue(".self-control", "height"), ".self-control height");
  const targetWidth = pixels(declaredValue(".self-control::after", "width"), ".self-control::after width");
  const targetHeight = pixels(declaredValue(".self-control::after", "height"), ".self-control::after height");
  const meterFlex = flexParts(declaredValue(".self-controls .level", "flex"), ".self-controls .level flex");
  const meterBasis = pixels(meterFlex.basis, ".self-controls .level flex basis");
  const meterMinWidth = pixels(declaredValue(".self-controls .level", "min-width"), ".self-controls .level min-width");
  const gap = pixels(declaredValue(".self-controls", "gap"), ".self-controls gap");
  const stackWidths = declaredValues(".self-stack", "width");

  /**
   * What a wrapping flex container actually reserves for the meter when it decides where the
   * line breaks: the flex basis, clamped up by min-width. The larger of the two is the floor.
   */
  const meterFloor = Math.max(meterBasis, meterMinWidth);
  const narrowestStack = Math.min(
    ...stackWidths.map((value, index) => pixels(value, `.self-stack width #${index + 1}`)),
  );

  it("finds the stack widths this guard reasons about, so a rename cannot silently empty it", () => {
    expect(
      stackWidths,
      "expected a base `.self-stack` width and the narrow phone override, in that order",
    ).toHaveLength(2);
  });

  describe("fits on one line, in every language", () => {
    it("leaves the buttons, the gaps and the meter floor room inside the narrowest stack", () => {
      const reserved = 2 * buttonWidth + 2 * gap + meterFloor;
      expect(
        reserved,
        `the row reserves ${reserved}px before it wraps and the narrowest stack is ${narrowestStack}px. Both buttons are icons, so this one number covers every language rather than only the widest one.`,
      ).toBeLessThanOrEqual(narrowestStack);
    });

    it("keeps the wrap, which is now an escape valve nothing can reach", () => {
      // Load bearing while the buttons held text: two Spanish labels alone overflowed the 108px
      // phone stack, and the wrap was all that kept them inside the video. The check above says
      // the row now fits without it in every language. It stays anyway, because removing a
      // safety net is the owner's call rather than this test's, and because the failure it
      // catches puts a button outside the video rather than underneath one.
      expect(
        declaredValue(".self-controls", "flex-wrap"),
        "without the wrap an overflowing row has nowhere to put the second button",
      ).toBe("wrap");
    });

    it("keeps the meter visible at its floor, and able to grow back", () => {
      expect(meterFloor, "a meter that can reach zero width cannot tell you your microphone is live").toBeGreaterThan(0);
      expect(pixels(declaredValue(".self-controls .level", "height"), ".self-controls .level height")).toBeGreaterThan(0);
      expect(declaredValues(".self-controls .level", "display"), "the meter is never hidden").toEqual([]);
      expect(
        meterFlex.grow,
        "the meter has to take the leftover width back when the icons leave room, or it sits at its floor forever",
      ).toBeGreaterThan(0);
    });
  });

  describe("stays tappable on a phone", () => {
    it("draws the button square, so the icon is centred rather than sitting in a text shaped box", () => {
      expect(
        buttonWidth,
        "an icon in an oblong box reads as misaligned however the flex box centres it",
      ).toBe(buttonHeight);
      expect(declaredValue(".self-control", "align-items")).toBe("center");
      expect(declaredValue(".self-control", "justify-content")).toBe("center");
    });

    it("grows the tap target past the button rather than shipping the button's own size", () => {
      expect(
        targetWidth,
        `the button is drawn ${buttonWidth}px wide, so the ::after has to carry the rest of the target`,
      ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(targetHeight).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(
        declaredValue(".self-control::after", "position"),
        "a target laid out in flow would push the row apart instead of overhanging it",
      ).toBe("absolute");
      expect(
        declaredValue(".self-control", "position"),
        "an absolutely positioned target centres on the nearest positioned ancestor, which has to be its own button",
      ).toBe("relative");
    });

    it("keeps the two targets off each other, so one tap reaches one control", () => {
      // Each target is centred on its button and the buttons sit at the two ends of the row, so
      // the centres are buttonWidth/2 in from each end. The meter between them is not
      // interactive, so a target overhanging IT costs nothing; one reaching the other button
      // costs a tap, because the later element in the DOM wins the overlap.
      const betweenCentres = narrowestStack - buttonWidth;
      expect(
        betweenCentres,
        `on the ${narrowestStack}px stack the two ${targetWidth}px targets sit ${betweenCentres}px apart centre to centre, so they overlap and the camera takes taps meant for the microphone`,
      ).toBeGreaterThanOrEqual(targetWidth);
    });
  });
});

/**
 * The theme controls: Theme and Appearance, side by side, each an icon over its own select.
 *
 * Appearance used to be a fieldset of three radio pills under the theme select, and the two
 * controls read as two unrelated stacked things. They are one row now, which moves the whole
 * problem into the stylesheet: two controls on one line inside a drawer, holding option text in
 * a language this file cannot measure.
 *
 * NOTHING HERE IS SIZED ON A STRING, and there is no longer a number here to be wrong about
 * one. The fields were 13em, one shared font relative width guessed for a label above a
 * select; with the label hidden each field is the select, and a select's auto width is its
 * widest option in the reader's own language. The guarantee is still not "the text fits" (a
 * stylesheet cannot know that) but "the text cannot take the drawer with it": the row wraps,
 * and each field may shrink below the width its own options want.
 *
 * The self view row's lesson applies again here. A wrapping flex container decides where the
 * line breaks using each item's HYPOTHETICAL main size, which is the flex basis clamped UP by
 * min-width, and not the size the item would shrink to. So a field whose min-width defaulted to
 * auto would be floored by its select's longest option, in whatever language the reader has,
 * and that floor is what would push the row past the edge of the drawer.
 */

/** Every published minimum agrees on this, and the drawer is the one surface used on a phone. */
const MIN_SELECT_HEIGHT_PX = MIN_TOUCH_TARGET_PX;

/** Whitespace separated tokens of a value, without splitting the inside of a calc() or var(). */
function topLevelTokens(value: string): string[] {
  const tokens: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth === 0 && /\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Every selector in the file, so a rule left behind by a deletion can be found by name. */
function allSelectors(): string[] {
  return DECLARATIONS.flatMap((rule) => rule.selectors).filter(Boolean);
}

describe("the theme controls sit on one row", () => {
  const fieldFlex = flexParts(declaredValue(".theme-field", "flex"), ".theme-field flex");

  it("finds one shared size for both fields, so neither is sized on its own label", () => {
    // Two rules would let somebody widen Appearance for "System" and leave Theme alone, which
    // is the English shaped bug this row is most likely to grow.
    expect(
      declaredValues(".theme-field", "flex"),
      "both fields are the same field: one rule sizes them, or the row is sized per language",
    ).toHaveLength(1);
  });

  it("sizes each field on the reader's own options rather than on a number", () => {
    // This was an em, and the em was the right answer while the field was a label ABOVE a
    // select: one font relative width, guessed once, covering two different strings. With the
    // label hidden the field IS the select, and a select's auto width is its widest option in
    // whatever language the reader has. That is their text MEASURED rather than guessed at,
    // and it asks for no more room than it needs, which is what a bar trying to fit three
    // groups on one line is short of. A px basis would be somebody's English, taken once.
    expect(
      fieldFlex.basis,
      `the basis is "${fieldFlex.basis}", which is a number somebody chose for one language`,
    ).toBe("auto");
  });

  it("changes the font size nowhere above the bar, since every control in it is sized by text", () => {
    for (const selector of [
      "html",
      "body",
      ".control-drawer",
      ".drawer-body",
      ".settings-bar",
      ".settings-group",
      ".theme-picker",
      ".theme-field",
    ]) {
      expect(
        declaredValues(selector, "font-size"),
        `"${selector}" sets a font size, so every control under it is a different width than the rest of the app and the bar's one line is decided somewhere nobody would look`,
      ).toEqual([]);
    }
  });

  it("wraps rather than running the second control off the side of the drawer", () => {
    expect(declaredValue(".theme-picker", "display")).toBe("flex");
    expect(
      declaredValue(".theme-picker", "flex-wrap"),
      "a nowrap row has nowhere to put Appearance once the two no longer fit",
    ).toBe("wrap");
  });

  /**
   * What replaced the arithmetic that used to be here.
   *
   * There was a check that one field at its full 13em basis fits between the drawer's gutters
   * on a 320px phone. That number is gone with the basis, and the promise it stood for is now
   * structural instead: a field asks for its own options and can be squeezed below them, so
   * there is no width at which it is bigger than the space it has. A guard that multiplied an
   * em by 16 could only ever have answered for one font size anyway.
   */
  it("lets a field shrink below its natural width instead of overflowing", () => {
    expect(
      fieldFlex.shrink,
      "a field that cannot shrink is a field that overflows the drawer on the narrowest phone",
    ).toBeGreaterThan(0);
    expect(
      declaredValue(".theme-field", "min-width"),
      "min-width defaults to auto in a flex row, which floors the field at its select's longest option, in whatever language the reader has",
    ).toMatch(/^0(px)?$/);
  });

  it("keeps both selects thumb sized", () => {
    expect(
      pixels(declaredValue(".theme-field select", "min-height"), ".theme-field select min-height"),
      "the drawer is the one surface that has to work on a phone in one tap",
    ).toBeGreaterThanOrEqual(MIN_SELECT_HEIGHT_PX);
  });

  it("leaves no rules behind for the radio pills it replaced", () => {
    // A dead rule reads as a live one to the next person, and these two carried a whole
    // component's worth of styling: a pill border, a checked colour and an input reset.
    const orphans = allSelectors().filter((selector) => selector.includes("theme-mode"));
    expect(orphans, "the radios are gone, so these rules match nothing").toEqual([]);
  });

  it("leaves no rules behind for the tagline or the row that held it", () => {
    // The tagline is gone outright, copy keys and all, and with it gone the group's own row is
    // the row: a column wrapping a single row is an invitation to put a second line back.
    const orphans = allSelectors().filter(
      (selector) => selector.includes("theme-tagline") || selector.includes("theme-row"),
    );
    expect(orphans, "these rules match nothing in the drawer any more").toEqual([]);
  });
});

/**
 * The settings bar: language, theme and chat controls, spread across the drawer in that order.
 *
 * The drawer used to be a stack, and the whole of this change is a layout one, so nearly all of
 * it is a promise this file has to keep. Room.test.ts holds the other half, which is that there
 * are three groups and that every control sits inside one of them.
 *
 * Three things are pinned here that the markup cannot state.
 *
 *   1. A GROUP CANNOT BE SPLIT. The bar wraps, and a wrapping flex container moves its own
 *      ITEMS between lines. Each group being its own flex container is what makes its controls
 *      not items of the bar, so the only thing the bar can ever move is a whole group. That is
 *      a structural guarantee rather than an arithmetic one, and it holds at every width and in
 *      every language, which is why the groups are not sized here at all.
 *   2. NOTHING OVERFLOWS SIDEWAYS. .drawer-body scrolls vertically, and a box with one axis
 *      scrolling and the other visible computes the visible axis to auto, so a group too wide
 *      for its line would not spill: it would grow a horizontal scrollbar. Each group wraps its
 *      OWN controls instead, which stacks them and keeps them together, the escape valve the
 *      theme group already had before it became one of the three.
 *   3. EVERY GROUP IS ONE LINE OF CONTROLS, which is the point of the change this suite was
 *      last edited for. The theme group was two rows tall, a labelled select row plus a line
 *      of prose under it, while the other two were one, and a bar cannot sit on a single line
 *      while one of its three groups is twice the height of the others.
 */

/** Every group of the bar, so a promise made about one of them is made about all three. */
const GROUP_SELECTORS = [".settings-group", ".theme-picker"];

describe("the settings bar spreads three groups across the drawer", () => {
  it("gives the bar and the header a full width row each, so neither can share a line", () => {
    for (const selector of [".settings-bar", ".drawer-header"]) {
      expect(
        flexParts(declaredValue(selector, "flex"), `${selector} flex`).basis,
        `"${selector}" is a ROW of the drawer body, not an item beside another one`,
      ).toBe("100%");
    }
    expect(
      declaredValue(".drawer-body", "flex-wrap"),
      "the two rows only stack because the body they sit in wraps",
    ).toBe("wrap");
  });

  it("spreads the groups across the whole bar", () => {
    expect(declaredValue(".settings-bar", "display")).toBe("flex");
    expect(
      declaredValue(".settings-bar", "justify-content"),
      "the three groups are spaced apart across the bar, not packed against its left edge",
    ).toBe("space-between");
    expect(
      declaredValue(".settings-bar", "flex-wrap"),
      "a nowrap bar has nowhere to put the third group on a phone",
    ).toBe("wrap");
  });

  it("makes every group its own flex container, so the bar can only ever wrap whole groups", () => {
    for (const selector of GROUP_SELECTORS) {
      expect(
        declaredValue(selector, "display"),
        `"${selector}" holding its controls as a container is what stops the bar wrapping between them`,
      ).toBe("flex");
    }
  });

  it("lets a group stack its own controls rather than overflow the drawer sideways", () => {
    for (const selector of GROUP_SELECTORS) {
      expect(
        declaredValue(selector, "flex-wrap"),
        `a group that cannot stack can only overflow, and .drawer-body turns that into a horizontal scrollbar`,
      ).toBe("wrap");
    }
    expect(
      declaredValue(".settings-group", "min-width"),
      "min-width defaults to auto on a flex item, which floors the group at its widest translation and breaks the bar's lines on that floor",
    ).toMatch(/^0(px)?$/);
  });

  it("stops the theme controls claiming a row of their own", () => {
    expect(
      declaredValues(".theme-picker", "flex").filter((value) => value.includes("100%")),
      "a full width basis is what forced the theme controls onto their own line, which is the thing this layout undoes",
    ).toEqual([]);
  });

  it("drops the rule that separated the theme controls as a stacked section", () => {
    expect(
      declaredValues(".theme-picker", "border-top"),
      "a line above one group of three on a shared row reads as a divider, not as a section start",
    ).toEqual([]);
  });

  /**
   * ONE ROW PER GROUP, which is the actual point of the change this suite is being edited for.
   *
   * Said as declarations rather than as a height, because this file has no layout engine: a row
   * of controls has whatever height its longest control gives it, and nothing here can lay text
   * out to find that number. What CAN be stated is the structural reason the old bar was two
   * rows tall in the middle and one either side. A group is a flex container, and a flex
   * container puts its children on ONE line unless something says otherwise. The two things
   * that can say otherwise are `flex-direction: column` and a full width item, and both are
   * checked below for every group.
   *
   * The wrap is not one of those things. It is the escape valve, reached only when a line
   * genuinely runs out of room, and a group that stacks on a 320px phone is the graceful
   * version of not fitting rather than a second row by design.
   */
  it("gives every group one line of controls, which is why the bar fits on one line", () => {
    for (const selector of GROUP_SELECTORS) {
      expect(
        declaredValues(selector, "flex-direction"),
        `"${selector}" laid out as a column is a group two rows tall, whatever the bar does`,
      ).toEqual([]);
      expect(
        declaredValues(selector, "flex").filter((value) => value.includes("100%")),
        `a full width item pushes everything after it onto a second line inside "${selector}"`,
      ).toEqual([]);
    }
  });

  it("keeps End chat off the gear by giving the bar the drawer's whole width", () => {
    // The gear used to sit ON this line, and the right padding was its footprint: 62px of
    // gutter that space-between then pressed End chat, an irreversible control, flat against.
    // The gear has its own row above the bar now, so the bar's gutters are ordinary padding,
    // equal on both sides, and the thing that keeps the two apart is the row between them
    // (pinned in "the gear rides above the drawer" below) rather than an arithmetic margin.
    const padding = topLevelTokens(declaredValue(".drawer-body", "padding"));
    expect(padding, "this guard reads the four value padding shorthand").toHaveLength(4);
    const right = pixels(padding[1] as string, ".drawer-body right padding");
    const left = pixels(padding[3] as string, ".drawer-body left padding");
    expect(
      right,
      `the bar still reserves ${right}px on the right against ${left}px on the left, which is a gear sized gutter for a gear that is no longer there`,
    ).toBe(left);
  });

  it("ends up exactly as tall as the composer beside it", () => {
    /*
     * The settings sheet and the message composer sit side by side along the bottom of the
     * window in two different containers, so nothing makes them the same depth except these
     * numbers agreeing. They looked like two panels of different heights until they did.
     *
     * The one figure a stylesheet cannot read is how tall the composer's tallest child renders,
     * so it is a measured constant. Measured in Chrome at 1280x800: the Send button is 42px,
     * taller than the 38px field, so it sets the composer's content height. Re-measure with
     * `document.querySelector(".composer button").getBoundingClientRect().height` if the
     * button's padding or font size ever changes, and update the number here rather than
     * loosening this test.
     */
    const COMPOSER_TALLEST_CHILD_PX = 42;

    const drawer = topLevelTokens(declaredValue(".drawer-body", "padding"));
    expect(drawer, "this guard reads the four value padding shorthand").toHaveLength(4);
    // The bottom is calc(10px + env(...)); env is zero on a desktop, which is where these two
    // are ever seen together, so the literal is what counts.
    const drawerHeight =
      pixels(drawer[0] as string, ".drawer-body padding-top") +
      MIN_TOUCH_TARGET_PX +
      10;

    const composerPadding = topLevelTokens(declaredValue(".composer", "padding"));
    expect(composerPadding, "this guard reads the two value padding shorthand").toHaveLength(2);
    const composerHeight =
      1 + pixels(composerPadding[0] as string, ".composer padding block") * 2 + COMPOSER_TALLEST_CHILD_PX;

    expect(
      drawerHeight,
      "the settings sheet and the composer are different depths, so the bottom of the window reads as two panels rather than one band",
    ).toBe(composerHeight);
  });

  it("keeps every control in a group thumb sized", () => {
    expect(
      pixels(declaredValue(".settings-group > *", "min-height"), ".settings-group > * min-height"),
      "the drawer is the one surface that has to work on a phone in one tap",
    ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
  });

  it("sizes the dialect picker to its own options rather than to its group", () => {
    expect(
      declaredValue(".dialect-select", "width"),
      "the global `select` rule is width 100%, which would stretch it across the whole group",
    ).toBe("auto");
  });
});

/*
 * The gear, and the dock that carries both it and the drawer.
 *
 * THE GEAR IS HOW THE DRAWER IS OPENED, so it has to be visible and reachable while the drawer
 * is shut. That is the constraint every rule below exists to keep, and it is the reason the
 * gear was positioned on .room in the first place: a gear inside a sheet that slides off screen
 * slides off with it, and the drawer can never be opened again.
 *
 * It used to sit on the settings bar's own line, vertically centred over it, with a 62px right
 * gutter in .drawer-body reserving its footprint. space-between then pressed End chat, an
 * irreversible control, against that gutter, 12px from a button you can hit by accident.
 *
 * The arrangement now is one DOCK holding two rows: the gear's row on top, the sheet under it.
 * The dock is what slides, and it stops short. Shut, it is translated down by its own height
 * LESS the gear's row, so exactly that row is left on screen along the bottom of the video.
 * Open, it is translated to zero and the gear sits in the drawer's own top row. So the gear
 * never leaves the screen, it never overlaps the bar, and there is no second copy of it to
 * keep in step.
 *
 * The gear sits at the START of that row. The end put it directly above End chat, which moved
 * the crowding rather than removing it. Moving it also moved the SHUT button, from the bottom
 * right of the video to the bottom left, which was the owner's call: the row the gear sits in
 * is the row that stays on screen, so the two positions cannot be chosen separately.
 *
 * Three things follow, and each is pinned below because each is a way to lose the gear.
 *
 *   1. THE ARITHMETIC IS ONE NUMBER. The height the dock stops short by and the height of the
 *      gear's row are the same custom property. Two literals that agree today would drift, and
 *      drifting either way is a bug you only see on a phone: too little and a strip of the
 *      sheet sits over the video, too much and the gear is off the bottom of the screen.
 *   2. NOTHING BUT THE GEAR IS PRESSABLE WHILE SHUT. The dock spans the width of the room, so
 *      without this it would swallow every tap along the bottom of the video.
 *   3. THE SLIDE IS THE DOCK'S. The gear used to carry its own `right` transition so it tracked
 *      the transcript panel on the same curve as the drawer beside it. One element carrying
 *      both is what makes it impossible for them to disagree about where that edge is.
 */
describe("the gear rides above the drawer", () => {
  /** A length declared as a custom property on the dock, which is where this arithmetic lives. */
  function dockLength(name: string): number {
    return pixels(declaredValue(".drawer-dock", name), `.drawer-dock ${name}`);
  }

  const gearSize = dockLength("--gear-size");
  const gearInset = dockLength("--gear-inset");
  const handleHeight = declaredValue(".drawer-dock", "--drawer-handle-height");

  it("lays the gear out in the handle row instead of positioning it over the drawer", () => {
    // `relative` is fine and is what the tap target below is hung on. What must never come back
    // is the gear taking itself OUT of the flow to float over the drawer, which is the whole
    // arrangement this dock replaced.
    expect(
      declaredValues(".gear-button", "position"),
      "the gear positions itself out of the flow again, so it is floating over the drawer rather than sitting in the row that reserves its space",
    ).not.toContain("absolute");
    expect(declaredValues(".gear-button", "position")).not.toContain("fixed");
    for (const property of ["right", "bottom", "top", "left"]) {
      expect(
        declaredValues(".gear-button", property),
        `the gear sets "${property}", which only means anything if it has taken itself out of the flow`,
      ).toEqual([]);
    }
    expect(declaredValue(".drawer-handle", "display")).toBe("flex");
    expect(
      declaredValue(".drawer-handle", "justify-content"),
      "the gear sits at the START of the drawer's top row. At the end it was directly above End chat, an irreversible control, about 17px away, which is the crowding the dock existed to remove rather than relocate.",
    ).toBe("flex-start");
  });

  it("reserves the gear's footprint on the side the gear is actually on", () => {
    // The mobile conversation overlay pads one side by the gear's footprint so the composer
    // cannot land underneath it. That gutter has to be on the same side as the gear: kept on
    // the side it left, it is two bugs at once, a gap reserved for nothing and a collision.
    expect(
      declaredValues(".drawer-handle", "padding-right"),
      "padding on the side the gear is no longer on reserves space for nothing",
    ).toEqual([]);
    const conversation = topLevelTokens(declaredValue(".conversation", "padding"));
    expect(conversation, "this guard reads the four value padding shorthand").toHaveLength(4);
    expect(
      pixels(conversation[3] as string, ".conversation left padding"),
      "the composer has to clear the gear, which is now on the left",
    ).toBeGreaterThanOrEqual(gearSize + gearInset);
  });

  it("reserves the gear's whole footprint in that row, and nothing more", () => {
    expect(
      handleHeight,
      "the tab's height has to be exactly the gear plus the padding actually drawn around it, or the dock stops short by the wrong amount and the gear is not where it was. The two sides differ: the bottom meets the sheet and stays tight.",
    ).toBe("calc(var(--gear-size) + var(--gear-tab-pad) + var(--gear-inset))");
    expect(declaredValue(".drawer-handle", "height")).toBe("var(--drawer-handle-height)");
    expect(
      declaredValue(".drawer-handle", "padding"),
      "the tab is the gear plus its padding and nothing else, and the bottom is the tight one because that edge meets the sheet",
    ).toBe("var(--gear-tab-pad) var(--gear-tab-pad) var(--gear-inset)");
    expect(
      declaredValue(".drawer-handle", "width"),
      "a full width handle is a band of surface across the drawer with one button adrift in it, which is the thing the tab replaced",
    ).toBe("max-content");
    expect(gearInset, "a gear flush against the edge of the screen is a gear you cannot press").toBeGreaterThan(0);
  });

  it("keeps a thumb sized tap target even though the gear is drawn smaller than one", () => {
    // The row is deliberately no bigger than the gear plus 5px, so the row is NOT the target
    // any more. The target is a transparent ::after, centred on the gear, the same trick the
    // mic and camera buttons use. This is the control that opens the drawer, so if it is not
    // pressable then neither is anything inside it, including both ways out of the call.
    expect(
      gearSize,
      "the gear is drawn smaller than a thumb, which is the whole reason the target below is separate from it",
    ).toBeLessThan(MIN_TOUCH_TARGET_PX);
    for (const axis of ["width", "height"]) {
      expect(
        pixels(declaredValue(".gear-button::after", axis), `.gear-button::after ${axis}`),
        `the gear's tap target is under ${MIN_TOUCH_TARGET_PX}px on its ${axis}`,
      ).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    }
    expect(
      declaredValue(".gear-button", "position"),
      "the target is absolutely positioned against the gear, so the gear has to be a containing block or it centres on the page instead",
    ).toBe("relative");
  });

  it("stops the shut dock exactly one row short, so the gear stays on screen", () => {
    expect(
      declaredValue(".drawer-dock", "transform"),
      "shut, the dock slides down by its own height LESS the gear's row. Any other length either leaves a strip of the sheet over the video or takes the gear off the bottom of the screen with it, and the drawer can then never be opened.",
    ).toBe("translateY(calc(100% - var(--drawer-handle-height)))");
    expect(declaredValue(".drawer-dock.open", "transform")).toBe("translateY(0)");
    expect(
      declaredValue(".drawer-dock", "bottom"),
      "the dock is measured from the bottom of the room, which is what makes that 100% mean anything",
    ).toBe("0");
  });

  it("leaves nothing but the gear pressable while the drawer is shut", () => {
    expect(
      declaredValue(".drawer-dock", "pointer-events"),
      "the dock spans the room, so a shut one catches taps all along the bottom of the video",
    ).toBe("none");
    expect(
      declaredValue(".gear-button", "pointer-events"),
      "the gear is the one thing that opts back in, because it is the one thing you can press",
    ).toBe("auto");
    expect(
      declaredValue(".drawer-dock.open", "pointer-events"),
      "an open drawer is a sheet, and a sheet takes its own clicks",
    ).toBe("auto");
  });

  it("slides the gear and the sheet as one thing when the transcript opens", () => {
    // The first, which is the ordinary rule. The second is the reduced motion override, which
    // is a different promise and is checked on its own below.
    const transition = declaredValues(".drawer-dock", "transition")[0] as string;
    expect(transition, "the dock carries the drawer's own slide").toContain("transform");
    expect(
      transition,
      "and the `right` one the gear used to carry alone, which is what stopped it snapping",
    ).toContain("right");
    expect(
      declaredValue(".stage.with-panel ~ .drawer-dock", "right"),
      "the dock stops where the transcript panel starts",
    ).toMatch(/^\d+px$/);
    expect(
      allSelectors().filter((selector) => selector.includes("~ .gear-button")),
      "the gear inset from the panel edge is the dock's now: two rules for one edge is how they come to disagree",
    ).toEqual([]);
  });

  it("leaves the sheet inside the dock rather than positioning it for itself", () => {
    for (const property of ["position", "transform", "transition"]) {
      expect(
        declaredValues(".control-drawer", property),
        `the sheet sets "${property}", so it can move out from under the gear that is supposed to be riding it`,
      ).toEqual([]);
    }
  });

  it("drops the dock's slide for a reader who asked for less motion", () => {
    const guarded = blocks.flatMap((block) =>
      parseRules(block.body, block.start).filter(
        (rule) => rule.selectors.includes(".drawer-dock") && rule.properties.has("transition"),
      ),
    );
    expect(
      guarded,
      "the dock is the one thing that slides now, so it is the one thing that has to stop",
    ).toHaveLength(1);
  });
});

/*
 * Every select in the app draws its own chevron.
 *
 * `appearance: none` is what makes a select look like the rest of this stylesheet rather than
 * like whatever the OS draws, and it is also what takes the browser's own arrow away. So the
 * arrow has to come back, at a known inset, with the text padded clear of it: a long option
 * ("English (United States)", "Igual que el sistema") running underneath a glyph is worse than
 * the jammed up arrow this replaced.
 *
 * Drawn as real inline SVG over the control rather than as a `data:` URI background image. The
 * icons in this app are elements: they inherit currentColor, they are read in the same house
 * style as the gear and the microphone, and a URI encoded copy of one in a stylesheet is a
 * second place to edit every time one of them changes.
 *
 * The one thing appearance: none takes that this file has to replace by hand is the OS focus
 * ring. The rule that does it already existed and is checked below rather than rewritten.
 */
describe("the select chrome", () => {
  const CHEVRON = ".select-shell > .select-chevron";
  const ICON = ".select-shell > .select-icon";

  it("turns the native control off, in Safari too", () => {
    expect(declaredValue("select", "appearance")).toBe("none");
    expect(
      declaredValue("select", "-webkit-appearance"),
      "Safari still reads the prefixed property, and without it the native arrow stays",
    ).toBe("none");
  });

  it("leaves every input alone, which is where this would do real damage", () => {
    // The `input, select` rule is shared. An appearance: none in there takes the box away from
    // the checkbox in PreJoin and the reader is left with an invisible control they cannot see
    // the state of.
    expect(
      declaredValues("input", "appearance").concat(declaredValues("input", "-webkit-appearance")),
      "appearance: none belongs on the select rule, never on the pair",
    ).toEqual([]);
  });

  it("pads the text clear of the chevron", () => {
    const inset = pixels(declaredValue(CHEVRON, "right"), `${CHEVRON} right`);
    const width = pixels(declaredValue(CHEVRON, "width"), `${CHEVRON} width`);
    const padding = pixels(declaredValue("select", "padding-right"), "select padding-right");
    expect(inset, "the owner asked for a fixed 12px inset from the right edge").toBe(12);
    expect(
      padding,
      `the chevron occupies the ${inset + width}px nearest the right edge, so a longer option runs underneath it`,
    ).toBeGreaterThan(inset + width);
  });

  it("pads the text clear of a leading icon, but only where there is one", () => {
    const inset = pixels(declaredValue(ICON, "left"), `${ICON} left`);
    const width = pixels(declaredValue(ICON, "width"), `${ICON} width`);
    const padding = pixels(declaredValue(".select-icon + select", "padding-left"), "icon padding-left");
    expect(
      padding,
      `the icon occupies the ${inset + width}px nearest the left edge, so the chosen option starts underneath it`,
    ).toBeGreaterThan(inset + width);
    expect(
      declaredValues("select", "padding-left"),
      "a select with no icon keeps the ordinary left padding the shared rule gives it",
    ).toEqual([]);
  });

  it("lays both glyphs over the control without taking its clicks", () => {
    expect(
      declaredValue(".select-shell", "position"),
      "an absolutely positioned glyph needs the shell to be what it is positioned against",
    ).toBe("relative");
    for (const selector of [CHEVRON, ICON]) {
      expect(declaredValue(selector, "position")).toBe("absolute");
      expect(
        declaredValue(selector, "pointer-events"),
        `a click on "${selector}" has to reach the select underneath, or the arrow is a dead spot on the control it belongs to`,
      ).toBe("none");
    }
  });

  it("still draws a focus ring, which the OS was drawing until appearance: none", () => {
    const outline = declaredValue("select:focus", "outline");
    expect(outline, "a select with no focus ring cannot be tabbed to visibly").not.toBe("none");
    expect(
      outline,
      "the rule that carries it now is the one that was already there, in the theme's accent",
    ).toMatch(/^\d+px solid var\(--accent\)$/);
  });
});

/**
 * On is the accent, off is `--muted`.
 *
 * This replaced a green against red pair at matched lightness, which is precisely the pairing
 * red green colour blindness collapses: presence of colour means on, and the two states no
 * longer differ by hue alone. Nothing pinned that. Inverting the two rules outright, so on read
 * as danger and off as accent, left all 460 client tests passing, which means the accessibility
 * reasoning behind the change was prose rather than a guard.
 *
 * `--muted` is asserted by name rather than as "any non accent value". The point is not that off
 * differs from on, it is that off carries NO colour: a second hue would satisfy a difference
 * check and lose the whole rule.
 */
describe("state colour says on by presence, not by hue", () => {
  it("colours the on state with the accent and the off state with nothing", () => {
    expect(declaredValue(".state-on", "color")).toBe("var(--accent)");
    expect(
      declaredValue(".state-off", "color"),
      "off has to be the absence of colour, so that on and off do not differ by hue alone",
    ).toBe("var(--muted)");
  });

  it("outlines the toggle the same way, accent when on and the ordinary line when off", () => {
    expect(declaredValue("button.toggle-on", "border-color")).toBe("var(--accent-quiet)");
    expect(
      declaredValue("button.toggle-off", "border-color"),
      "an off toggle outlined in a second hue is the red against green pair again, in the border",
    ).toBe("var(--line)");
  });

  it("keeps a weight difference, so the state survives without colour at all", () => {
    for (const selector of [".state-on", ".state-off"]) {
      expect(
        declaredValue(selector, "font-weight"),
        `"${selector}" leans on colour alone once its weight matches the surrounding text`,
      ).toBe("600");
    }
  });
});
