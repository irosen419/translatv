// The two theme controls in the settings drawer: which palette, and light against dark.
//
// No DOM here, and none added. The client suite runs vitest in the node environment, and the
// precedent in this tree is to test a render decision as a plain function: Room.test.ts calls
// SelfControlButton and reads the React element it hands back as data. ThemePickerView is the
// same shape, hook free on purpose, so the copy and the choice are arguments rather than hooks
// and this file can hand it a real Copy for any dialect.
//
// What this cannot see, said rather than faked: whether a browser paints two controls on one
// line. That is the stylesheet's promise and styles.test.ts holds it. What lives here is the
// MARKUP promise: which elements exist, what they offer, and whether each one is labelled.

import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";

import { copyFor } from "../i18n/copy.js";
import { THEMES } from "../theme/palettes.js";
import { THEME_MODES, type ThemeChoice } from "../theme/theme.js";
import { ThemePickerView } from "./ThemePicker.js";

const CHOICE: ThemeChoice = { paletteId: "harbor", mode: "dark" };

function render(choice: ThemeChoice = CHOICE, dialect = "en-US"): ReactElement {
  return ThemePickerView({
    theme: choice,
    copy: copyFor(dialect),
    onChoose: () => undefined,
  });
}

/** What each control was asked to change, captured instead of applied. */
function renderRecording(choice: ThemeChoice = CHOICE): {
  tree: ReactElement;
  changes: Array<Partial<ThemeChoice>>;
} {
  const changes: Array<Partial<ThemeChoice>> = [];
  const tree = ThemePickerView({
    theme: choice,
    copy: copyFor("en-US"),
    onChoose: (change) => changes.push(change),
  });
  return { tree, changes };
}

/**
 * Every plain element in a tree, with function components called the way React would call them.
 *
 * The two fields are one component rendered twice, so without this every assertion below would
 * stop at an uncalled function and read nothing.
 */
function elements(node: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
    return found;
  }
  if (node === null || node === undefined || typeof node !== "object") return found;
  const element = node as ReactElement;
  if (typeof element.type === "function") {
    return elements((element.type as (props: unknown) => unknown)(element.props), found);
  }
  found.push(element);
  return elements((element.props as { children?: unknown } | undefined)?.children, found);
}

function ofType(node: unknown, type: string): ReactElement[] {
  return elements(node).filter((element) => element.type === type);
}

/** One element as it is laid out: a function component called, so its own element is reached. */
function laidOut(element: ReactElement): ReactElement {
  return typeof element.type === "function"
    ? laidOut((element.type as (props: unknown) => ReactElement)(element.props))
    : element;
}

/**
 * The element children of one node, in order, each laid out.
 *
 * ORDER is the point of this helper. Which icon belongs to which select is a question about
 * adjacency: the stylesheet positions `.select-icon + select`, so an icon that is not
 * immediately before its select is an icon drawn over nothing.
 */
function childrenOf(node: ReactElement): ReactElement[] {
  const found: ReactElement[] = [];
  const walk = (child: unknown): void => {
    if (Array.isArray(child)) {
      for (const one of child) walk(one);
      return;
    }
    if (child === null || child === undefined || typeof child !== "object") return;
    found.push(laidOut(child as ReactElement));
  };
  walk((node.props as { children?: unknown }).children);
  return found;
}

function classesOf(element: ReactElement): string[] {
  return String((element.props as { className?: unknown }).className ?? "").split(" ");
}

/**
 * Every string a reader would SEE, which is neither an attribute nor a hidden label.
 *
 * Options are skipped: the chosen one is the control's own value rather than prose beside it,
 * and the other nine are not on screen until the control is opened. A `.visually-hidden` label
 * is skipped for the same reason a title is: it is a name for assistive tech, and the whole of
 * this change is that the name stopped taking a line of the drawer.
 */
function visibleTextOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleTextOf).join("");
  const element = node as ReactElement;
  if (typeof element.type === "function") {
    return visibleTextOf((element.type as (props: unknown) => unknown)(element.props));
  }
  if (element.type === "option") return "";
  if (classesOf(element).includes("visually-hidden")) return "";
  return visibleTextOf((element.props as { children?: unknown } | undefined)?.children);
}

interface Option {
  value: string;
  label: string;
}

function optionsOf(select: ReactElement): Option[] {
  return ofType(select, "option").map((option) => ({
    value: String(option.props.value),
    label: String((option.props as { children?: unknown }).children),
  }));
}

const MODE_VALUES = [...THEME_MODES] as string[];

/**
 * The appearance control, found by WHAT IT OFFERS rather than by an id or a position.
 *
 * An id is an implementation detail the label pairing already covers, and a position is the very
 * thing this change moved. The control that offers light, dark and system is the appearance
 * control in any arrangement of the drawer.
 */
function appearanceSelect(tree: ReactElement): ReactElement {
  const found = ofType(tree, "select").filter((select) =>
    optionsOf(select).some((option) => MODE_VALUES.includes(option.value)),
  );
  expect(found, "expected exactly one control offering the appearance modes").toHaveLength(1);
  return found[0] as ReactElement;
}

function paletteSelect(tree: ReactElement): ReactElement {
  const found = ofType(tree, "select").filter((select) =>
    optionsOf(select).some((option) => option.value === THEMES[0]?.id),
  );
  expect(found, "expected exactly one control offering the palettes").toHaveLength(1);
  return found[0] as ReactElement;
}

describe("appearance is a select, not a radio group", () => {
  it("offers all three modes, in the one order THEME_MODES declares", () => {
    expect(optionsOf(appearanceSelect(render())).map((option) => option.value)).toEqual(MODE_VALUES);
  });

  it("names each mode with its own copy, so no two options read the same", () => {
    const copy = copyFor("en-US");
    expect(optionsOf(appearanceSelect(render())).map((option) => option.label)).toEqual(
      THEME_MODES.map((mode) => copy.t(`room.theme.mode.${mode}`)),
    );
  });

  it("shows the mode currently chosen, whichever one that is", () => {
    for (const mode of THEME_MODES) {
      const select = appearanceSelect(render({ ...CHOICE, mode }));
      expect(select.props.value).toBe(mode);
      // A value no option carries renders an empty control that silently discards the choice.
      expect(optionsOf(select).map((option) => option.value)).toContain(select.props.value);
    }
  });

  it("reports the picked mode, and only the mode", () => {
    const { tree, changes } = renderRecording();
    appearanceSelect(tree).props.onChange({ target: { value: "light" } });
    expect(changes).toEqual([{ mode: "light" }]);
  });

  it("ignores a value that is not a mode rather than storing it", () => {
    // Unreachable through the options, and the same guard the palette control has carried since
    // it was written: a cast here would also swallow the day somebody renames a mode.
    const { tree, changes } = renderRecording();
    appearanceSelect(tree).props.onChange({ target: { value: "sepia" } });
    expect(changes).toEqual([]);
  });

  it("leaves no radio, fieldset or legend behind", () => {
    const leftover = elements(render())
      .map((element) => String(element.type))
      .filter((type) => ["input", "fieldset", "legend"].includes(type));
    expect(leftover, "the radio group was replaced, not duplicated").toEqual([]);
  });
});

describe("the palette control is unchanged by the move", () => {
  it("still offers every palette by its untranslated name", () => {
    const select = paletteSelect(render());
    expect(optionsOf(select)).toEqual(THEMES.map((theme) => ({ value: theme.id, label: theme.name })));
    expect(select.props.value).toBe(CHOICE.paletteId);
  });

  it("reports the picked palette, and only the palette", () => {
    const { tree, changes } = renderRecording();
    paletteSelect(tree).props.onChange({ target: { value: "iris" } });
    expect(changes).toEqual([{ paletteId: "iris" }]);
  });

  it("ignores a value that is not a palette id", () => {
    const { tree, changes } = renderRecording();
    paletteSelect(tree).props.onChange({ target: { value: "not-a-palette" } });
    expect(changes).toEqual([]);
  });
});

describe("both controls keep their name without spending a line on it", () => {
  const tree = render();
  const selects = ofType(tree, "select");
  const labels = ofType(tree, "label");

  it("draws two selects and two labels, one pair each", () => {
    expect(selects).toHaveLength(2);
    expect(labels).toHaveLength(2);
  });

  it("hides both labels rather than swapping them for an aria-label", () => {
    // A visually hidden LABEL keeps the label-and-control pairing the markup already had, which
    // an aria-label would replace with an attribute: the same name to a screen reader, and less
    // to anything else reading the page. What the hiding buys is the row: a label above each
    // select made this group two rows tall while the other two groups were one.
    for (const label of labels) {
      expect(
        classesOf(label),
        "the one visually hidden recipe in this app, reused rather than reinvented per control",
      ).toContain("visually-hidden");
    }
    for (const select of selects) {
      expect(
        select.props["aria-label"],
        "an aria-label beside a real label is a second name that can drift from the first",
      ).toBeUndefined();
    }
  });

  it("puts no visible label text in the group at all", () => {
    expect(
      visibleTextOf(tree),
      "any prose left here is a line the bar has to find room for, which is what this change undid",
    ).toBe("");
  });

  it("tells a sighted mouse user what each control is, through its title", () => {
    // The hidden label is the name assistive tech reads. A mouse user gets neither that nor a
    // visible one, so the title is the whole of what they have to go on.
    const copy = copyFor("en-US");
    expect(paletteSelect(tree).props.title).toBe(copy.t("room.theme.title"));
    expect(appearanceSelect(tree).props.title).toBe(copy.t("room.theme.appearance"));
  });

  it("pairs every select with a label that points at its id", () => {
    for (const select of selects) {
      const id = String(select.props.id ?? "");
      expect(id, "a select with no id cannot be the target of a label").not.toBe("");
      const pointing = labels.filter((label) => label.props.htmlFor === id);
      expect(
        pointing,
        `no <label htmlFor="${id}">, so this control has no accessible name at all`,
      ).toHaveLength(1);
    }
  });

  it("gives the two controls different ids, so one label cannot claim both", () => {
    const ids = selects.map((select) => String(select.props.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("puts real words in each label, in the reader's own dialect", () => {
    const copy = copyFor("es-AR");
    const spanish = ofType(render(CHOICE, "es-AR"), "label").map((label) =>
      String((label.props as { children?: unknown }).children),
    );
    expect(spanish).toEqual([copy.t("room.theme.label"), copy.t("room.theme.appearance")]);
  });
});

/**
 * The tagline is gone, not moved.
 *
 * It was a line of prose under the two controls describing the chosen palette. Inline in the
 * settings bar that line is what made this group two rows tall while the other two were one,
 * which is the whole reason the bar could not sit on a single line. Owner decision: it goes,
 * and the ten `themes.<id>.tagline` keys went with it in every locale. copy.test.ts holds that
 * half; this holds the half a locale file cannot see, which is that nothing renders one.
 */
describe("the tagline is gone", () => {
  it("draws no element for it, and no prose at all", () => {
    const leftover = elements(render()).filter((element) =>
      classesOf(element).includes("theme-tagline"),
    );
    expect(
      leftover,
      "a line of prose in the bar makes this group two rows tall, which is what this change undid",
    ).toEqual([]);
    expect(ofType(render(), "p"), "the tagline was the only prose in here").toEqual([]);
  });

  it("describes the chosen palette nowhere, in any theme or any dialect", () => {
    // Swept over every palette rather than the one in CHOICE: the tagline was per theme, so a
    // half finished removal would show up on the ninth one rather than the first.
    for (const theme of THEMES) {
      for (const dialect of ["en-US", "es-AR"]) {
        expect(visibleTextOf(render({ paletteId: theme.id, mode: "dark" }, dialect))).toBe("");
      }
    }
  });
});

/**
 * The two leading icons, one per select.
 *
 * A native select cannot contain an element, so each icon is a SIBLING laid over the select's
 * left padding, and the stylesheet positions it with `.select-icon + select`. Adjacency is
 * therefore the thing worth pinning: an icon that is not immediately before its select is an
 * icon drawn over the wrong control, or over nothing.
 *
 * `data-icon` is the hook, the same one the mic and camera work introduced. Path geometry moves
 * whenever somebody nudges a curve, and a guard that fails on a cosmetic edit teaches people to
 * edit the guard.
 */
describe("each control is introduced by an icon rather than by a label", () => {
  /** The field holding the select that offers these values, and everything drawn in it. */
  function fieldFor(tree: ReactElement, wanted: (select: ReactElement) => boolean): ReactElement[] {
    const fields = elements(tree)
      .filter((element) => classesOf(element).includes("theme-field"))
      .map(childrenOf)
      .filter((drawn) => drawn.some((child) => child.type === "select" && wanted(child)));
    expect(fields, "expected exactly one field holding this control").toHaveLength(1);
    return fields[0] as ReactElement[];
  }

  function iconBefore(drawn: ReactElement[]): ReactElement {
    const index = drawn.findIndex((child) => child.type === "select");
    expect(index, "the select has nothing drawn before it, so no icon is over its padding").toBeGreaterThan(0);
    return drawn[index - 1] as ReactElement;
  }

  const byPalettes = (select: ReactElement) =>
    optionsOf(select).some((option) => option.value === THEMES[0]?.id);
  const byModes = (select: ReactElement) =>
    optionsOf(select).some((option) => MODE_VALUES.includes(option.value));

  const CASES = [
    { name: "the palette control", find: byPalettes, icon: "palette" },
    { name: "the appearance control", find: byModes, icon: "contrast" },
  ] as const;

  for (const testCase of CASES) {
    it(`draws the ${testCase.icon} icon immediately before ${testCase.name}`, () => {
      const icon = iconBefore(fieldFor(render(), testCase.find));
      expect(icon.type).toBe("svg");
      expect(icon.props["data-icon"]).toBe(testCase.icon);
      expect(classesOf(icon), "the stylesheet lays it over the select by this class").toContain(
        "select-icon",
      );
    });
  }

  it("draws a different icon for each, so neither is a silent duplicate", () => {
    const drawn = CASES.map((testCase) =>
      String(iconBefore(fieldFor(render(), testCase.find)).props["data-icon"]),
    );
    expect(new Set(drawn).size, `the two controls drew ${drawn.join(", ")}`).toBe(CASES.length);
  });

  it("keeps both icons out of the accessible name, which the hidden label carries", () => {
    for (const testCase of CASES) {
      const icon = iconBefore(fieldFor(render(), testCase.find));
      expect(icon.props["aria-hidden"]).toBe("true");
      expect(icon.props.focusable).toBe("false");
      // The house style every other icon in this app is drawn in, so one of them cannot quietly
      // stop inheriting the palette or stop being a stroke drawing.
      expect(icon.props.viewBox).toBe("0 0 24 24");
      expect(icon.props.fill).toBe("none");
      expect(icon.props.stroke).toBe("currentColor");
    }
  });
});

describe("the theme group is one row of the settings bar", () => {
  it("holds the two fields and nothing else", () => {
    const drawn = childrenOf(render());
    expect(
      drawn.map((child) => String(child.type)),
      "a third child is a second line, which is the whole thing this change removes",
    ).toEqual(["div", "div"]);
    for (const field of drawn) expect(classesOf(field)).toContain("theme-field");
  });

  it("puts one select in each field", () => {
    for (const field of childrenOf(render())) expect(ofType(field, "select")).toHaveLength(1);
  });
});
