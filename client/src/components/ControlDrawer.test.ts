// The settings drawer's frame: the gear, the sheet, and which of them is which.
//
// No DOM here, and none added. The client suite runs vitest in the node environment, and the
// precedent in this tree is to test a render decision as a plain function: Room.test.ts calls
// SelfControlButton and DrawerContents and reads the React elements they hand back as data.
// DrawerFrame is the same shape, hook free on purpose, so `open` is an argument rather than a
// useState and this file can ask for both states in the same breath. ControlDrawer keeps the
// hooks and hands what they produce to the frame.
//
// What this file exists for is ONE PROPERTY: the gear is how the drawer is opened, so it has to
// stay visible and reachable while the drawer is shut. Everything below is a different way of
// losing that, and every one of them is a change somebody could make while believing they were
// tidying the markup up.
//
// What this cannot see, said rather than faked: where a browser PAINTS the two rows. That the
// shut dock stops one row short so the gear is still on screen is a promise of the stylesheet,
// and client/src/styles.test.ts holds it.

import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";

import { copyFor } from "../i18n/copy.js";
import { DrawerFrame, type DrawerFrameProps } from "./ControlDrawer.js";

const COPY = copyFor("en-US");

function frame(open: boolean, onToggle: () => void = () => undefined): ReactElement {
  const props: DrawerFrameProps = {
    open,
    onToggle,
    copy: COPY,
    children: "the settings themselves",
  };
  return DrawerFrame(props);
}

/** Every plain element in a tree, with function components called the way React would call them. */
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

/** One element as it is laid out: a function component called, so its own element is reached. */
function laidOut(element: ReactElement): ReactElement {
  return typeof element.type === "function"
    ? laidOut((element.type as (props: unknown) => ReactElement)(element.props))
    : element;
}

/** The direct element children of one node, in order, each laid out. */
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

function withClass(node: unknown, className: string): ReactElement[] {
  return elements(node).filter((element) => classesOf(element).includes(className));
}

function only(found: ReactElement[], what: string): ReactElement {
  expect(found, `expected exactly one ${what}`).toHaveLength(1);
  return found[0] as ReactElement;
}

function dockOf(tree: ReactElement): ReactElement {
  return only(withClass(tree, "drawer-dock"), ".drawer-dock holding the gear and the sheet");
}

function handleOf(tree: ReactElement): ReactElement {
  return only(withClass(tree, "drawer-handle"), ".drawer-handle holding the gear");
}

function sheetOf(tree: ReactElement): ReactElement {
  return only(
    elements(tree).filter((element) => (element.props as { id?: unknown }).id === "control-drawer"),
    "element carrying the id the gear points its aria-controls at",
  );
}

function gearOf(tree: ReactElement): ReactElement {
  return only(withClass(tree, "gear-button"), ".gear-button");
}

describe("the gear survives the drawer being shut", () => {
  for (const open of [false, true]) {
    it(`draws exactly one gear with the drawer ${open ? "open" : "shut"}`, () => {
      // One, not two. A second copy inside the sheet would be a second tab stop announcing the
      // same control, and the two would drift the first time either was edited.
      expect(withClass(frame(open), "gear-button")).toHaveLength(1);
    });
  }

  it("keeps the gear OUT of the sheet, which is what goes inert while shut", () => {
    const tree = frame(false);
    expect(
      withClass(sheetOf(tree), "gear-button"),
      "a gear inside the sheet is a gear that is hidden from assistive tech and out of the tab order exactly when it is the only way back in",
    ).toEqual([]);
  });

  it("puts the gear in the dock's own handle row, at the end of it", () => {
    const handle = handleOf(frame(true));
    expect(withClass(handle, "gear-button")).toHaveLength(1);
    // Last, because the row is laid out flex-end: the gear is at the drawer's right edge, and
    // anything added to this row later belongs before it rather than outside it.
    const drawn = childrenOf(handle);
    expect(
      classesOf(drawn[drawn.length - 1] as ReactElement),
      "the gear belongs at the END of the drawer's top row",
    ).toContain("gear-button");
    // The row is inside the dock, so the one transform that slides the drawer slides the gear
    // with it rather than the two being animated separately and drifting apart.
    expect(withClass(dockOf(frame(true)), "drawer-handle")).toHaveLength(1);
  });

  it("marks the dock open rather than only the sheet, since the dock is what moves", () => {
    expect(classesOf(dockOf(frame(true)))).toContain("open");
    expect(classesOf(dockOf(frame(false)))).not.toContain("open");
  });
});

describe("the sheet is what hides, and it hides completely", () => {
  it("takes itself out of assistive tech and out of the tab order while shut", () => {
    const sheet = sheetOf(frame(false));
    expect(sheet.props["aria-hidden"]).toBe(true);
    expect(
      sheet.props.inert,
      "the sheet is slid off screen rather than unmounted, and an offscreen control is still focusable",
    ).toBe("");
  });

  it("gives it all back when open", () => {
    const sheet = sheetOf(frame(true));
    expect(sheet.props["aria-hidden"]).toBe(false);
    expect(sheet.props.inert).toBeUndefined();
  });

  it("never marks the gear itself hidden or inert, in either state", () => {
    for (const open of [false, true]) {
      const gear = gearOf(frame(open));
      expect(gear.props["aria-hidden"]).toBeUndefined();
      expect(gear.props.inert).toBeUndefined();
    }
  });

  it("holds the settings inside the sheet, not beside it", () => {
    expect(String(sheetOf(frame(true)).props.children)).not.toBe("");
    expect(
      elements(sheetOf(frame(true))).filter((element) =>
        classesOf(element).includes("drawer-body"),
      ),
    ).toHaveLength(1);
  });
});

describe("the gear says what it is and what it will do", () => {
  it("points at the sheet it opens", () => {
    expect(gearOf(frame(false)).props["aria-controls"]).toBe("control-drawer");
    expect(sheetOf(frame(false)).props.id).toBe("control-drawer");
  });

  it("reports whether the drawer is open", () => {
    expect(gearOf(frame(false)).props["aria-expanded"]).toBe(false);
    expect(gearOf(frame(true)).props["aria-expanded"]).toBe(true);
  });

  it("names the action in the reader's own dialect, and titles itself too", () => {
    const shut = gearOf(frame(false));
    expect(shut.props["aria-label"]).toBe(COPY.t("room.settings.open"));
    expect(shut.props.title).toBe(COPY.t("room.settings.title"));
    const open = gearOf(frame(true));
    expect(open.props["aria-label"]).toBe(COPY.t("room.settings.close"));
    expect(open.props.title).toBe(COPY.t("room.settings.close"));
  });

  it("toggles, and is the only thing that does", () => {
    const pressed: string[] = [];
    const tree = frame(false, () => pressed.push("toggle"));
    gearOf(tree).props.onClick();
    expect(pressed).toEqual(["toggle"]);
  });
});
