// The self view microphone and camera toggles.
//
// No DOM here, and none added. The client suite runs vitest in the node environment, and the
// precedent in this tree is to test render logic as a plain function: lib/chips.ts decides WHICH
// chips exist so that decision can be checked without a browser. SelfControlButton is hook free,
// so calling it is an ordinary function call and the React element it hands back is plain data.
// Attributes are object properties, and the icon is a child whose own function can be called in
// turn to reach the svg. Every assertion below reads that data.
//
// What this cannot see, said rather than faked: whether a browser paints the element. Turning a
// React element into pixels is React's job and not something this repo should be re-testing.

import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { DIALECTS } from "@translatv/shared";

import { copyFor } from "../i18n/copy.js";
import { THEMES } from "../theme/palettes.js";
import { THEME_MODES, type ThemeChoice } from "../theme/theme.js";
import {
  DrawerContents,
  SelfControlButton,
  SttAlertNotice,
  type DrawerContentsProps,
  type SelfControlButtonProps,
} from "./Room.js";

/** The English action phrasings, as Room passes them in. Only their identity matters here. */
const LABEL = {
  mute: "Mute your microphone",
  unmute: "Unmute your microphone",
  cameraOff: "Turn your camera off",
  cameraOn: "Turn your camera on",
};

function render(props: Omit<SelfControlButtonProps, "onClick">): ReactElement {
  return SelfControlButton({ ...props, onClick: () => undefined });
}

/** The svg this button drew, reached by calling the icon component the same way React would. */
function iconOf(rendered: ReactElement): ReactElement {
  const children = rendered.props.children as unknown;
  // Checked rather than assumed, so a second child reports itself here instead of arriving as an
  // unreadable TypeError in every assertion that goes through this helper.
  expect(
    Array.isArray(children),
    "the button has more than one child, so it is no longer an icon on its own",
  ).toBe(false);
  const icon = children as ReactElement;
  return (icon.type as (props: unknown) => ReactElement)(icon.props);
}

/**
 * The name of the icon this button drew.
 *
 * `data-icon` exists for this assertion and for nothing else. Path geometry is the wrong thing
 * to pin: it moves whenever somebody nudges a curve, and a guard that fails on a cosmetic edit
 * teaches people to edit the guard.
 */
function iconNameOf(rendered: ReactElement): string {
  return String(iconOf(rendered).props["data-icon"]);
}

/** Every string a reader would SEE inside this element. Attributes are not text on screen. */
function visibleTextOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleTextOf).join("");
  const element = node as ReactElement;
  if (typeof element.type === "function") {
    const draw = element.type as (props: unknown) => unknown;
    return visibleTextOf(draw(element.props));
  }
  return visibleTextOf((element.props as { children?: unknown } | undefined)?.children);
}

/** The four states the row can be in, and what each one is supposed to say. */
const STATES = [
  { name: "mic live", props: { device: "mic", live: true, actionLabel: LABEL.mute }, icon: "mic" },
  { name: "mic muted", props: { device: "mic", live: false, actionLabel: LABEL.unmute }, icon: "mic-off" },
  { name: "camera on", props: { device: "camera", live: true, actionLabel: LABEL.cameraOff }, icon: "camera" },
  { name: "camera off", props: { device: "camera", live: false, actionLabel: LABEL.cameraOn }, icon: "camera-off" },
] as const satisfies ReadonlyArray<{
  name: string;
  props: Omit<SelfControlButtonProps, "onClick">;
  icon: string;
}>;

describe("the self view toggle icon reports the STATE", () => {
  for (const state of STATES) {
    it(`draws the ${state.icon} icon when the ${state.name}`, () => {
      expect(iconNameOf(render(state.props))).toBe(state.icon);
    });
  }

  it("draws a different icon in all four states, so none of them is a silent duplicate", () => {
    const drawn = STATES.map((state) => iconNameOf(render(state.props)));
    expect(new Set(drawn).size, `four states drew ${drawn.join(", ")}`).toBe(STATES.length);
  });
});

/**
 * The icon and the accessible name DELIBERATELY DISAGREE, and neither is the other's mistake.
 *
 * The icon reports the state, because that is what an icon is read as: a crossed out microphone
 * means "you are muted" in Zoom, Meet and Teams, and it is what people arrive already knowing.
 * The name reports what pressing the button will do, because that is what a name is read as: a
 * screen reader announces the control you are about to activate, and "microphone, muted" leaves
 * the listener to guess what happens next.
 *
 * Note that this INVERTS the visible labels these buttons used to carry, which named the action
 * ("Mute" while you were live). Anybody reading the pair as a bug and swapping one to match the
 * other should find this test and its reasoning before they get very far.
 */
describe("the self view toggle accessible name reports the ACTION", () => {
  for (const state of STATES) {
    it(`offers "${state.props.actionLabel}" when the ${state.name}`, () => {
      const rendered = render(state.props);
      expect(rendered.props["aria-label"]).toBe(state.props.actionLabel);
      // The tooltip says the same thing, so a sighted mouse user discovers the action too, and
      // so the two never drift into describing the button differently.
      expect(rendered.props.title).toBe(state.props.actionLabel);
    });
  }

  it("keeps the icon out of the accessible name, which is the action and nothing else", () => {
    for (const state of STATES) {
      expect(iconOf(render(state.props)).props["aria-hidden"]).toBe("true");
    }
  });
});

describe("the self view toggles are icon only", () => {
  for (const state of STATES) {
    it(`puts no readable text in the button when the ${state.name}`, () => {
      expect(visibleTextOf(render(state.props))).toBe("");
    });
  }
});

describe("the self view toggle carries its state in a class as well as its icon", () => {
  // Colour is the second half of the signal: .self-control.off paints the danger hue. An icon
  // alone would ask somebody to tell two small glyphs apart at 14px on a phone.
  it("marks a stopped device off, and a live one not", () => {
    for (const state of STATES) {
      const className = String(render(state.props).props.className);
      expect(className.split(" ")).toContain("self-control");
      expect(className.includes("off"), `${state.name} className was "${className}"`).toBe(
        !state.props.live,
      );
    }
  });
});

/*
 * The settings drawer: one inline bar of three groups, in one order.
 *
 * Same node only approach as the rest of this file. DrawerContents is hook free on purpose, so
 * calling it is an ordinary function call and the tree it hands back is plain data: which
 * groups exist, what each one holds, and what each control reports when it is used.
 *
 * What this cannot see, said rather than faked: where a browser PAINTS those groups. That the
 * bar is a wrapping flex row spread with space-between, that each group is its own flex
 * container and therefore cannot be split across two lines by the bar's wrap, and that the
 * header row and the bar each claim a full width row of the drawer, are promises of the
 * stylesheet, and styles.test.ts holds them. What lives here is the STRUCTURE those rules are
 * applied to: three groups, in order, with every control inside one of them.
 */

/** The controls a group can hold. A bar child of one of these types is a control, not a group. */
const CONTROL_TYPES = ["select", "button", "input", "textarea"];

const THEME: ThemeChoice = { paletteId: "harbor", mode: "dark" };
const COPY = copyFor("en-US");

/** The whole drawer, with every handler a no op. */
function drawerProps(): DrawerContentsProps {
  return {
    copy: COPY,
    header: null,
    language: {
      dialect: "en-US",
      onChangeDialect: () => undefined,
      translationOn: true,
      translationMoot: false,
      onToggleTranslation: () => undefined,
    },
    theme: { choice: THEME, onChoose: () => undefined },
    chat: { onLeave: () => undefined, onEnd: () => undefined },
  };
}

function drawer(props: DrawerContentsProps = drawerProps()): ReactElement {
  return DrawerContents(props);
}

/**
 * Every plain element in a tree, with function components called the way React would call them.
 *
 * The theme group IS a function component, so without this every assertion about the middle
 * group would stop at an uncalled function and read nothing.
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

function optionValuesOf(node: unknown): string[] {
  return ofType(node, "option").map((option) => String(option.props.value));
}

/** One element as it is laid out: a function component called, so its own element is reached. */
function laidOut(element: ReactElement): ReactElement {
  return typeof element.type === "function"
    ? laidOut((element.type as (props: unknown) => ReactElement)(element.props))
    : element;
}

/** The element children of a node, with the branches that rendered nothing dropped. */
function childrenOf(node: ReactElement): ReactElement[] {
  const children = (node.props as { children?: unknown }).children;
  const list = Array.isArray(children) ? children : [children];
  return list.filter((child): child is ReactElement => typeof child === "object" && child !== null);
}

function classesOf(element: ReactElement): string[] {
  return String((element.props as { className?: unknown }).className ?? "").split(" ");
}

function rowOf(tree: ReactElement, className: string): ReactElement | undefined {
  return childrenOf(tree).find((row) => classesOf(row).includes(className));
}

function barOf(tree: ReactElement): ReactElement {
  const bar = rowOf(tree, "settings-bar");
  expect(bar, "expected one .settings-bar holding the settings").toBeDefined();
  return bar as ReactElement;
}

function groupsOf(tree: ReactElement): ReactElement[] {
  return childrenOf(barOf(tree)).map(laidOut);
}

/**
 * Which group this is, by WHAT IT OFFERS rather than by a class or a position.
 *
 * Position is the very thing this layout decides, so reading it back off a position would
 * assert nothing, and a class name is a label somebody can move without moving the controls.
 */
function identify(group: ReactElement): string {
  const offered = optionValuesOf(group);
  if (offered.includes(String(DIALECTS[0]?.code))) return "language";
  if (offered.includes(String(THEMES[0]?.id))) return "theme";
  if (ofType(group, "button").length > 0) return "chat controls";
  return "unrecognized";
}

/** The dialect picker, found the same way: the one control offering the dialect codes. */
function dialectSelect(tree: ReactElement): ReactElement {
  const found = ofType(tree, "select").filter((select) =>
    optionValuesOf(select).includes(String(DIALECTS[0]?.code)),
  );
  expect(found, "expected exactly one control offering the dialects").toHaveLength(1);
  return found[0] as ReactElement;
}

describe("the settings drawer is one bar of three groups", () => {
  const tree = drawer();
  const groups = groupsOf(tree);

  it("holds three groups and no loose control", () => {
    expect(groups).toHaveLength(3);
    expect(
      groups.map((group) => String(group.type)).filter((type) => CONTROL_TYPES.includes(type)),
      "a control sitting directly in the bar is one the bar can wrap away from the rest of its group",
    ).toEqual([]);
  });

  it("orders them language, theme, chat controls", () => {
    expect(groups.map(identify)).toEqual(["language", "theme", "chat controls"]);
  });

  it("puts every control in the bar inside one of the three", () => {
    const count = (node: ReactElement) => ofType(node, "select").length + ofType(node, "button").length;
    const inBar = count(barOf(tree));
    expect(
      groups.reduce((total, group) => total + count(group), 0),
      "a control the groups cannot account for is one the bar is laying out on its own",
    ).toBe(inBar);
    expect(
      inBar,
      "three selects (dialect, palette, appearance) and three buttons (translation, Leave, End chat)",
    ).toBe(6);
  });
});

describe("each group keeps its own members", () => {
  const [language, theme, chat] = groupsOf(drawer());

  it("gives the language group the dialect picker and the translation toggle, and nothing else", () => {
    expect(ofType(language, "select")).toHaveLength(1);
    expect(optionValuesOf(language)).toEqual(DIALECTS.map((dialect) => dialect.code));
    expect(
      ofType(language, "button").map(visibleTextOf),
      "the toggle is about language too, which is why it sits here rather than with the chat controls",
    ).toEqual([`${COPY.t("room.translation.lead")} ${COPY.t("room.translation.on")}`]);
  });

  it("gives the theme group both theme selects and no button", () => {
    expect(ofType(theme, "select").map(optionValuesOf)).toEqual([
      THEMES.map((option) => option.id),
      [...THEME_MODES],
    ]);
    expect(ofType(theme, "button")).toEqual([]);
  });

  it("gives the chat controls group Leave and End chat, in that order, and no select", () => {
    expect(ofType(chat, "button").map(visibleTextOf)).toEqual([
      COPY.t("room.leave"),
      COPY.t("room.end"),
    ]);
    expect(ofType(chat, "select")).toEqual([]);
  });

  it("leaves the dialect picker's sizing to the stylesheet", () => {
    expect(
      dialectSelect(drawer()).props.style,
      "an inline style fights a group based layout, and styles.test.ts cannot see one",
    ).toBeUndefined();
  });

  it("gives every select in the bar a shell, because it has to draw its own chevron", () => {
    // `appearance: none` took the browser's arrow off every select in the app, so a select
    // outside a shell is a control with no affordance at all: it reads as a text box that
    // cannot be typed in. The shell is also the positioning context the arrow is drawn against,
    // which is why one per select rather than one per group.
    const tree = drawer();
    const shells = elements(tree).filter((element) =>
      String((element.props as { className?: unknown }).className ?? "")
        .split(" ")
        .includes("select-shell"),
    );
    expect(shells, "three selects: the dialect picker and the two theme controls").toHaveLength(3);
    for (const shell of shells) {
      expect(ofType(shell, "select"), "one shell wraps one select").toHaveLength(1);
      expect(
        ofType(shell, "svg").filter((svg) => svg.props["data-icon"] === "chevron"),
        "the shell draws the chevron the browser stopped drawing",
      ).toHaveLength(1);
    }
    expect(ofType(tree, "select")).toHaveLength(shells.length);
  });
});

describe("the bar reports what was used, one control at a time", () => {
  /** Every handler recording what it was told rather than doing it. */
  function recording(): { tree: ReactElement; used: string[] } {
    const used: string[] = [];
    const base = drawerProps();
    const tree = DrawerContents({
      ...base,
      language: {
        ...base.language,
        onChangeDialect: (dialect) => used.push(`dialect ${dialect}`),
        onToggleTranslation: () => used.push("translation"),
      },
      theme: { ...base.theme, onChoose: (change) => used.push(`theme ${JSON.stringify(change)}`) },
      chat: { onLeave: () => used.push("leave"), onEnd: () => used.push("end") },
    });
    return { tree, used };
  }

  it("wires each control to its own handler and to no other", () => {
    const { tree, used } = recording();
    const [language, theme, chat] = groupsOf(tree);
    dialectSelect(tree).props.onChange({ target: { value: "es-AR" } });
    (ofType(language, "button")[0] as ReactElement).props.onClick();
    (ofType(theme, "select")[1] as ReactElement).props.onChange({ target: { value: "light" } });
    for (const button of ofType(chat, "button")) button.props.onClick();
    expect(used).toEqual([
      "dialect es-AR",
      "translation",
      'theme {"mode":"light"}',
      "leave",
      "end",
    ]);
  });
});

describe("the translation toggle says which state it is in", () => {
  function toggle(props: DrawerContentsProps): ReactElement {
    const [language] = groupsOf(drawer(props));
    return ofType(language, "button")[0] as ReactElement;
  }

  function withLanguage(change: Partial<DrawerContentsProps["language"]>): DrawerContentsProps {
    const base = drawerProps();
    return { ...base, language: { ...base.language, ...change } };
  }

  it("reads as the current state rather than as the action", () => {
    expect(visibleTextOf(toggle(withLanguage({ translationOn: false })))).toBe(
      `${COPY.t("room.translation.lead")} ${COPY.t("room.translation.off")}`,
    );
  });

  it("explains itself instead of disappearing when translating would do nothing", () => {
    const moot = toggle(withLanguage({ translationMoot: true }));
    expect(visibleTextOf(moot)).toBe(COPY.t("room.translation.moot"));
    expect(moot.props.disabled).toBe(true);
    expect(moot.props.title).toBe(COPY.t("room.translation.mootTitle"));
  });
});

describe("the narrow screen header keeps a row of its own above the bar", () => {
  const HEADER = "the room header a phone has nowhere else to put";

  it("wraps it in a row of its own, ahead of the bar", () => {
    const tree = drawer({ ...drawerProps(), header: HEADER });
    const rows = childrenOf(tree);
    const header = rowOf(tree, "drawer-header");
    expect(header, "expected a .drawer-header holding the names, the code and the chips").toBeDefined();
    expect(
      (header?.props as { children?: unknown }).children,
      "the header is passed through whole rather than being taken apart into the bar",
    ).toBe(HEADER);
    expect(
      rows.indexOf(header as ReactElement),
      "the header belongs above the settings, not after them",
    ).toBeLessThan(rows.indexOf(barOf(tree)));
  });

  it("keeps it out of the three groups", () => {
    expect(
      String(barOf(drawer({ ...drawerProps(), header: HEADER })).props.children),
    ).not.toContain(HEADER);
  });

  it("draws no header row at all on a screen whose top bar still has one", () => {
    expect(
      rowOf(drawer(), "drawer-header"),
      "an empty row still takes a gap and a line of the drawer",
    ).toBeUndefined();
  });
});

/**
 * The speech failure notice.
 *
 * Whether it appears is lib/chips.ts's decision and is tested there. This is what it says, and
 * it exists because the previous version of this was two words in a pill with the explanation
 * in a `title` tooltip: a real call ran with the speaker believing they were being subtitled,
 * and a phone never shows a tooltip. So the assertions below are mostly about text being
 * PRESENT as text rather than hidden in an attribute.
 */
describe("SttAlertNotice", () => {
  const alert = {
    title: "alert.noSubtitles.title",
    body: "alert.noSubtitles.body",
    notice: { key: "stt.permission" },
  } as const;

  const render = (onDismiss = () => undefined) =>
    SttAlertNotice({ alert, copy: COPY, onDismiss });

  /** Every string this element renders as visible text, flattened out of the React tree. */
  function textOf(node: unknown): string {
    if (node === null || node === undefined || typeof node === "boolean") return "";
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join(" ");
    const element = node as ReactElement;
    return textOf((element.props as { children?: unknown })?.children);
  }

  it("announces itself, so it is not only a sighted person who is told", () => {
    expect((render().props as { role?: string }).role).toBe("alert");
  });

  it("says it is your device and what the other person loses, both as text", () => {
    const text = textOf(render());
    expect(text).toContain(COPY.t("alert.noSubtitles.title"));
    expect(
      text,
      "the consequence is the part nobody works out for themselves, so it cannot live in a tooltip",
    ).toContain(COPY.t("alert.noSubtitles.body"));
  });

  it("carries the adapter's fix as visible text rather than as a title attribute", () => {
    // The whole failure this replaces: the instructions existed, in `title`, where a phone
    // could never show them.
    expect(textOf(render())).toContain(COPY.ref(alert.notice));
  });

  it("can be dismissed, and says so to a screen reader as well as to a pointer", () => {
    let dismissed = 0;
    const rendered = render(() => {
      dismissed += 1;
    });
    const children = (rendered.props as { children: ReactElement[] }).children;
    const button = children.find((child) => child?.props?.className === "icon-button");
    expect(button, "there is no dismiss control").toBeDefined();
    const props = button?.props as { onClick(): void; "aria-label": string };
    expect(props["aria-label"]).toBe(COPY.t("alert.dismiss"));
    props.onClick();
    expect(dismissed).toBe(1);
  });
});
