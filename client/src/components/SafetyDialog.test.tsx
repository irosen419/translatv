// @vitest-environment happy-dom
//
// The report or block dialog, rendered: blocking always asks first, a report needs a reason, what
// is sent is what was chosen, and a refusal is said out loud rather than swallowed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyFor } from "../i18n/copy.js";
import type { ReportInput, SafetyResult } from "../lib/safety.js";
import { useStore } from "../state/store.js";
import { SafetyDialog, type SafetyActions } from "./SafetyDialog.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = copyFor("en-US");
let host: HTMLDivElement;
let root: Root;
let blocked: string[];
let reported: ReportInput[];
let answer: SafetyResult<{ blocked: boolean }>;
let onBlockedCalls: number;

const actions: SafetyActions = {
  block: async (contactId) => {
    blocked.push(contactId);
    return answer;
  },
  report: async (input) => {
    reported.push(input);
    return answer;
  },
};

function render(alreadyBlocked = false): void {
  act(() => {
    root.render(
      <SafetyDialog
        contactId="c1"
        name="Ben"
        alreadyBlocked={alreadyBlocked}
        actions={actions}
        onBlocked={() => (onBlockedCalls += 1)}
        onClose={() => undefined}
      />,
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll("button")].find((b) => b.textContent === text);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button "${text}"`);
  return found;
}

async function click(text: string): Promise<void> {
  await act(async () => {
    button(text).click();
  });
}

function choose(reason: string): void {
  const radio = host.querySelector<HTMLInputElement>(`input[type=radio][value=${reason}]`);
  if (!radio) throw new Error(`no ${reason}`);
  act(() => radio.click());
}

function heading(): string {
  return host.querySelector("h2")?.textContent ?? "";
}

beforeEach(() => {
  useStore.setState({ uiDialect: "en-US", supportEmail: null });
  const proto = (globalThis as { HTMLDialogElement?: { prototype: { showModal?: () => void } } }).HTMLDialogElement?.prototype;
  if (proto && typeof proto.showModal !== "function") proto.showModal = () => {};
  blocked = [];
  reported = [];
  onBlockedCalls = 0;
  answer = { ok: true, value: { blocked: false } };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("blocking", () => {
  it("asks first, and blocks only on the confirmation", async () => {
    render();
    await click(copy.t("safety.block.button", { name: "Ben" }));
    expect(blocked).toEqual([]);
    expect(heading()).toBe(copy.t("safety.confirm.title", { name: "Ben" }));
    expect(document.activeElement?.textContent).toBe(heading());
    await click(copy.t("safety.confirm.block"));
    expect(blocked).toEqual(["c1"]);
    expect(onBlockedCalls).toBe(1);
    expect(host.querySelector("[role=status]")?.textContent).toBe(copy.t("safety.done.blocked", { name: "Ben" }));
  });

  it("goes back without blocking on Cancel", async () => {
    render();
    await click(copy.t("safety.block.button", { name: "Ben" }));
    await click(copy.t("safety.cancel"));
    expect(blocked).toEqual([]);
    expect(heading()).toBe(copy.t("safety.title", { name: "Ben" }));
  });

  it("says why when it was refused, and does not claim success", async () => {
    answer = { ok: false, error: "CONTACT_NOT_FOUND" };
    render();
    await click(copy.t("safety.block.button", { name: "Ben" }));
    await click(copy.t("safety.confirm.block"));
    expect(host.querySelector("[role=alert]")?.textContent).toBe(copy.t("safety.error.CONTACT_NOT_FOUND"));
    expect(host.querySelector("[role=status]")).toBeNull();
    expect(onBlockedCalls).toBe(0);
  });

  it("is not offered for someone already blocked", () => {
    render(true);
    expect(() => button(copy.t("safety.block.button", { name: "Ben" }))).toThrow();
    expect(host.textContent).toContain(copy.t("safety.block.already", { name: "Ben" }));
    expect(host.querySelector("input[type=checkbox]")).toBeNull();
  });
});

describe("reporting", () => {
  it("needs a reason, and says so on the spot", async () => {
    render();
    await click(copy.t("safety.report.send"));
    expect(reported).toEqual([]);
    expect(host.querySelector("[role=alert]")?.textContent).toBe(copy.t("safety.report.pickReason"));
  });

  it("sends the reason and the details, with no block", async () => {
    render();
    choose("spam_or_scam");
    const field = host.querySelector<HTMLTextAreaElement>("#safety-details");
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    act(() => {
      setter?.call(field, "links to a fake shop");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("#safety-details-count")?.textContent).toBe(copy.t("safety.report.count", { count: 20, max: 500 }));
    await click(copy.t("safety.report.send"));
    expect(reported).toEqual([{ contactId: "c1", reason: "spam_or_scam", details: "links to a fake shop", alsoBlock: false }]);
    expect(host.querySelector("[role=status]")?.textContent).toBe(copy.t("safety.done.reported"));
    expect(onBlockedCalls).toBe(0);
  });

  it("with Also block ticked, asks before blocking, then sends both together", async () => {
    answer = { ok: true, value: { blocked: true } };
    render();
    choose("harassment");
    act(() => host.querySelector<HTMLInputElement>("input[type=checkbox]")?.click());
    await click(copy.t("safety.report.send"));
    expect(reported).toEqual([]);
    expect(heading()).toBe(copy.t("safety.confirm.title", { name: "Ben" }));
    await click(copy.t("safety.confirm.reportAndBlock"));
    expect(reported).toEqual([{ contactId: "c1", reason: "harassment", details: "", alsoBlock: true }]);
    expect(onBlockedCalls).toBe(1);
    expect(host.querySelector("[role=status]")?.textContent).toBe(copy.t("safety.done.reportedAndBlocked", { name: "Ben" }));
  });

  it("says the daily limit in words", async () => {
    answer = { ok: false, error: "RATE_LIMITED" };
    render();
    choose("other");
    await click(copy.t("safety.report.send"));
    expect(host.querySelector("[role=alert]")?.textContent).toBe(copy.t("safety.error.RATE_LIMITED"));
  });

  it("labels every control", () => {
    render();
    expect(host.querySelector("fieldset legend")?.textContent).toBe(copy.t("safety.report.reason"));
    expect(host.querySelector("label[for=safety-details]")).not.toBeNull();
    for (const radio of host.querySelectorAll("input[type=radio]")) expect(radio.closest("label")?.textContent).not.toBe("");
    expect(host.querySelector("dialog")?.getAttribute("aria-labelledby")).toBe("safety-step-title");
  });
});

describe("the support contact", () => {
  it("is a mailto link after a report when the server has one, and absent when it has none", async () => {
    useStore.setState({ supportEmail: "help@example.test" });
    render();
    choose("other");
    await click(copy.t("safety.report.send"));
    expect(host.querySelector("a")?.getAttribute("href")).toBe("mailto:help@example.test");

    act(() => root.unmount());
    root = createRoot(host);
    useStore.setState({ supportEmail: null });
    render();
    choose("other");
    await click(copy.t("safety.report.send"));
    expect(host.querySelector("a")).toBeNull();
  });
});
