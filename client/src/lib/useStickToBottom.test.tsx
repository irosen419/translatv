// @vitest-environment happy-dom
//
// Following a growing log. The bug this guards against: the old rule asked "is the reader near the
// bottom?" AFTER the new line had rendered, so any line taller than the slack (a long sentence
// with its translation under it) pushed the reader past it and the log stopped following. The
// question has to be asked about where the reader was BEFORE the line arrived.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useStickToBottom } from "./useStickToBottom.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let pinNow: ((force?: boolean) => void) | null = null;

const VIEW = 300;
/** happy-dom does no layout, so each item is given a height and the box is measured by hand. */
const heights: number[] = [];

function Log({ items }: { items: readonly number[] }) {
  const { ref, onScroll, pin } = useStickToBottom<HTMLDivElement>(items);
  pinNow = pin;
  return (
    <div id="log" ref={ref} onScroll={onScroll}>
      {items.map((h, i) => (
        <p key={i}>{h}</p>
      ))}
    </div>
  );
}

function log(): HTMLDivElement {
  return host.querySelector<HTMLDivElement>("#log")!;
}

function render(items: number[]): void {
  heights.splice(0, heights.length, ...items);
  act(() => root.render(<Log items={[...items]} />));
}

/** The reader scrolls to this offset, as a browser would: scrollTop moves, then scroll fires. */
function scrollTo(top: number): void {
  act(() => {
    log().scrollTop = top;
    log().dispatchEvent(new Event("scroll"));
  });
}

function distanceFromBottom(): number {
  const node = log();
  return node.scrollHeight - node.scrollTop - node.clientHeight;
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  let top = 0;
  const content = () => heights.reduce((a, b) => a + b, 0);
  // Mount the box first, then give it a layout.
  act(() => root.render(<Log items={[]} />));
  const node = log();
  Object.defineProperty(node, "clientHeight", { configurable: true, get: () => VIEW });
  Object.defineProperty(node, "scrollHeight", { configurable: true, get: () => Math.max(content(), VIEW) });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, Math.max(content(), VIEW) - VIEW));
    },
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  heights.length = 0;
});

describe("useStickToBottom", () => {
  it("follows each new line while the reader is at the bottom", () => {
    render([100, 100, 100]);
    render([100, 100, 100, 100]);
    expect(distanceFromBottom()).toBe(0);
  });

  it("follows a line taller than any slack, which is the line that used to strand the reader", () => {
    render([100, 100, 100]);
    render([100, 100, 100, 400]);
    expect(distanceFromBottom()).toBe(0);
  });

  it("leaves a reader who scrolled up where they are", () => {
    render([100, 100, 100, 100, 100]);
    scrollTo(0);
    render([100, 100, 100, 100, 100, 100]);
    expect(log().scrollTop).toBe(0);
  });

  it("starts following again once the reader scrolls back down", () => {
    render([100, 100, 100, 100, 100]);
    scrollTo(0);
    scrollTo(200);
    render([100, 100, 100, 100, 100, 100]);
    expect(distanceFromBottom()).toBe(0);
  });

  it("can be told to follow again, as sending a message does", () => {
    render([100, 100, 100, 100, 100]);
    scrollTo(0);
    act(() => pinNow?.(true));
    expect(distanceFromBottom()).toBe(0);
    render([100, 100, 100, 100, 100, 300]);
    expect(distanceFromBottom()).toBe(0);
  });
});
