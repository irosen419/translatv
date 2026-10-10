// @vitest-environment happy-dom
//
// The fix button and the correction dialog, rendered. The rules behind them are unit tested in
// lib/correction.test.ts; review found nothing tested that the panel USES them: showing the
// button on your own lines, swapping the phrase and the fix, and sending despite a problem each
// passed every client test, and the e2e cannot reach this (it runs with no API key, so no line is
// ever translated, so no fix button ever renders). A DOM is the instrument that sees it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClientMessage, Member, RenderedLine } from "@translatv/shared";
import { useStore } from "../state/store.js";
import { copyFor } from "../i18n/copy.js";
import { TranscriptPanel } from "./TranscriptPanel.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = copyFor("en-US");

function line(overrides: Partial<RenderedLine>): RenderedLine {
  return {
    lineId: "L1",
    from: "peer",
    srcDialect: "es-AR",
    text: "qué hacés, che",
    source: "speech",
    ts: "2026-10-10T00:00:00.000Z",
    translated: "what's up, hey",
    translationStatus: "ok",
    revision: 1,
    skipReason: null,
    ...overrides,
  } as RenderedLine;
}

const member = (id: string, dialect: string) =>
  ({
    id,
    username: id,
    dialect,
    connection: "connected",
    micEnabled: true,
    cameraEnabled: false,
    wantsTranslation: true,
  }) as unknown as Member;

let host: HTMLDivElement;
let root: Root;
let sent: Array<Extract<ClientMessage, { t: "glossary.correct" }>>;

function render(lines: RenderedLine[]): void {
  act(() => {
    root.render(
      <TranscriptPanel
        lines={lines}
        selfId="me"
        me={member("me", "en-US")}
        peer={member("peer", "es-AR")}
        onCorrect={(message) => sent.push(message)}
        onRetry={() => {}}
        onSendChat={() => {}}
      />,
    );
  });
}

const fixButtons = () =>
  [...host.querySelectorAll("button")].filter((b) => b.textContent === copy.t("panel.fix"));

/** Types into a React controlled textarea the way a person does: the value, then an input event. */
function type(id: string, value: string): void {
  const field = host.querySelector<HTMLTextAreaElement>(`#${id}`);
  if (!field) throw new Error(`no #${id}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
  act(() => {
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Presses Save, the button a person presses, so a Save that does not submit fails here. */
function save(): void {
  const button = [...host.querySelectorAll("dialog button")].find((b) => b.textContent === copy.t("correct.save"));
  if (!(button instanceof HTMLButtonElement)) throw new Error("no Save button");
  act(() => button.click());
}

beforeEach(() => {
  useStore.setState({ uiDialect: "en-US" });
  // happy-dom's dialog may not open modally; the panel only needs the call not to throw.
  const proto = (globalThis as { HTMLDialogElement?: { prototype: { showModal?: () => void } } }).HTMLDialogElement
    ?.prototype;
  if (proto && typeof proto.showModal !== "function") proto.showModal = () => {};
  sent = [];
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the fix button", () => {
  it("is on the other person's translated line, and not on your own (decision C2)", () => {
    render([line({ lineId: "L1", from: "peer" }), line({ lineId: "L2", from: "me", srcDialect: "en-US" })]);
    expect(fixButtons()).toHaveLength(1);
    const row = fixButtons()[0]?.closest("[data-line-id]");
    expect(row?.getAttribute("data-line-id")).toBe("L1");
  });

  it("is not on a line whose translation did not arrive", () => {
    render([line({ translationStatus: "unavailable", translated: null })]);
    expect(fixButtons()).toHaveLength(0);
  });
});

describe("the correction dialog", () => {
  it("sends the phrase as the source and the fix as the correction, trimmed", () => {
    render([line({})]);
    act(() => fixButtons()[0]?.click());
    type("correction-phrase", "  che ");
    type("correction-fix", " hey dude ");
    save();
    expect(sent).toEqual([{ t: "glossary.correct", lineId: "L1", source: "che", correctedTranslation: "hey dude" }]);
  });

  it("sends nothing while there is a problem, and says what it is", () => {
    render([line({})]);
    act(() => fixButtons()[0]?.click());
    type("correction-phrase", "che");
    type("correction-fix", "   ");
    save();
    expect(sent).toEqual([]);
    expect(host.querySelector("#correction-problem")?.getAttribute("role")).toBe("alert");
  });
});
