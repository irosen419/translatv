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

function parseRules(text: string, offset: number): Rule[] {
  const rules: Rule[] = [];
  // The delimiter is a LOOKBEHIND, not a captured group. Consuming it meant each match ate the
  // previous rule's closing brace, so consecutive rules parsed alternately: the grouped `.stage`
  // rule was skipped entirely and this suite passed over the very bug it exists to catch.
  for (const match of text.matchAll(/(?:^|(?<=[};{]))\s*([^{}@;]+?)\s*\{([^{}]*)\}/gm)) {
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
