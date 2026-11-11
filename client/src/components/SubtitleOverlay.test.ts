// The desktop subtitle's markup.
//
// No DOM here, and none added, for the reason Room.test.ts gives: SubtitleBlock is hook free, so
// calling it is an ordinary function call and the tree it hands back is plain data. What to show
// is decided in lib/caption.ts and tested there. This checks that the decision reaches the markup
// in the shape the CSS and the interim writer depend on.
//
// What this cannot see, said rather than faked: the hold timer firing, and the interim text that
// is written through the ref. Both need a browser.

import { createRef, type ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { copyFor } from "../i18n/copy.js";
import type { SubtitleView } from "../lib/caption.js";
import { SubtitleBlock } from "./SubtitleOverlay.js";

const copy = copyFor("en-US");

function view(over: Partial<SubtitleView> = {}): SubtitleView {
  return {
    caption: {
      primary: "hello",
      secondary: "hola",
      untranslated: false,
      pendingRow: null,
      noteKey: null,
    },
    captionShown: true,
    live: null,
    faded: false,
    ...over,
  };
}

function render(over: Partial<SubtitleView> = {}, interimRef = createRef<HTMLParagraphElement>()) {
  return SubtitleBlock({ view: view(over), copy, failureTitle: "why", interimRef });
}

/**
 * Every plain element in a tree, depth first, with function components called the way React
 * would call them. Without that, pulling a row out into its own hook free component (a correct
 * refactor) would hide it from every assertion here.
 */
function elements(node: unknown, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found);
    return found;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return found;
  const element = node as ReactElement;
  if (typeof element.type === "function") {
    return elements((element.type as (props: unknown) => unknown)(element.props), found);
  }
  found.push(element);
  return elements((element.props as { children?: unknown }).children, found);
}

const classOf = (element: ReactElement) => String((element.props as { className?: string }).className);
const withClass = (node: unknown, name: string) =>
  elements(node).filter((element) => classOf(element).split(" ").includes(name));

describe("SubtitleBlock", () => {
  // The live words get their OWN row, below the pair. Inside it they would sit directly under the
  // previous sentence's translation and read as a translation of it.
  it("puts the live row beside the held pair, never inside it", () => {
    const tree = render({ live: { text: "and then", pending: false } });
    const [held] = withClass(tree, "held");
    expect(held).toBeDefined();
    expect(withClass(held, "live")).toEqual([]);
    expect(withClass(tree, "live")).toHaveLength(1);
  });

  it("leaves interim speech to the ref, with no React text of its own", () => {
    const ref = createRef<HTMLParagraphElement>();
    const [row] = withClass(render({ live: { text: "and then", pending: false } }, ref), "live");
    expect((row as unknown as { ref: unknown }).ref).toBe(ref);
    expect((row?.props as { children?: unknown }).children).toBeUndefined();
  });

  it("renders a sentence waiting on its translation as a pending live row", () => {
    const [row] = withClass(render({ live: { text: "y despues", pending: true } }), "live");
    expect(classOf(row!).split(" ")).toContain("pending");
    expect((row?.props as { children?: unknown }).children).toBe("y despues");
  });

  it("has no live row when there is nothing live", () => {
    expect(withClass(render(), "live")).toEqual([]);
  });

  it("fades the whole overlay, and hides it from a screen reader, only when told to", () => {
    const gone = render({ captionShown: false, faded: true });
    expect(classOf(gone).split(" ")).toContain("faded");
    expect((gone.props as { "aria-hidden"?: boolean })["aria-hidden"]).toBe(true);

    const talking = render({ captionShown: false, faded: false, live: { text: "and", pending: false } });
    expect(classOf(talking).split(" ")).not.toContain("faded");
    expect((talking.props as { "aria-hidden"?: boolean })["aria-hidden"]).toBe(false);
  });

  it("fades the held pair in place when it is not shown", () => {
    const [held] = withClass(render({ captionShown: false }), "held");
    expect(classOf(held!).split(" ")).toContain("faded");
    expect((held?.props as { "aria-hidden"?: boolean })["aria-hidden"]).toBe(true);
  });

  it("marks the row still waiting on the model, and a failure with its reason", () => {
    const tree = render({
      caption: { primary: "...", secondary: "hola", untranslated: true, pendingRow: "primary", noteKey: null },
    });
    const [primary] = withClass(tree, "translated");
    expect(classOf(primary!).split(" ")).toEqual(expect.arrayContaining(["pending", "failed"]));
    const [marker] = withClass(tree, "marker");
    expect((marker?.props as { title?: string }).title).toBe("why");
  });
});
