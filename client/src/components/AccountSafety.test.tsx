// @vitest-environment happy-dom
//
// The account page's safety panels, rendered against a pretend API: recent calls open the report
// or block dialog for the right person, blocked people can be unblocked, and the owner's list
// marks a report reviewed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockedPerson, CallRecord, OwnerReport } from "@translatv/shared";

import { copyFor } from "../i18n/copy.js";
import type { SafetyApi } from "../lib/safety.js";
import { useStore } from "../state/store.js";
import { BlockedPeople, OwnerReports, RecentCalls } from "./AccountSafety.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = copyFor("en-US");
let host: HTMLDivElement;
let root: Root;

const calls: CallRecord[] = [
  { id: "k1", peer: { contactId: "c1", displayName: "Ben" }, startedAt: 1_800_000_000_000, endedAt: 1_800_000_060_000 },
  { id: "k2", peer: null, startedAt: 1_799_000_000_000, endedAt: null },
];

function fakeApi(state: { blocked: BlockedPerson[]; reports: OwnerReport[]; requests: string[] }): SafetyApi {
  return {
    calls: async () => ({ ok: true, value: { calls, nextCursor: null } }),
    blocks: async () => ({ ok: true, value: { blocked: state.blocked } }),
    block: async (contactId: string) => {
      state.requests.push(`block ${contactId}`);
      state.blocked = [{ contactId, displayName: "Ben", blockedAt: 1 }];
      return { ok: true, value: { blocked: state.blocked } };
    },
    unblock: async (contactId: string) => {
      state.requests.push(`unblock ${contactId}`);
      state.blocked = state.blocked.filter((b) => b.contactId !== contactId);
      return { ok: true, value: { blocked: state.blocked } };
    },
    report: async () => ({ ok: true, value: { id: "r", blocked: false } }),
    ownerReports: async () => ({ ok: true, value: { reports: state.reports } }),
    review: async (id: string) => {
      state.requests.push(`review ${id}`);
      const found = state.reports.find((r) => r.id === id) as OwnerReport;
      return { ok: true, value: { ...found, status: "reviewed", reviewedAt: 2 } };
    },
  } as unknown as SafetyApi;
}

async function click(text: string): Promise<void> {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === text || b.getAttribute("aria-label") === text);
  if (!button) throw new Error(`no button "${text}"`);
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  useStore.setState({ uiDialect: "en-US", supportEmail: null });
  const proto = (globalThis as { HTMLDialogElement?: { prototype: { showModal?: () => void } } }).HTMLDialogElement?.prototype;
  if (proto && typeof proto.showModal !== "function") proto.showModal = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("recent calls", () => {
  it("lists calls, offers Report or block only where there was someone, and opens it for them", async () => {
    const state = { blocked: [] as BlockedPerson[], reports: [], requests: [] as string[] };
    act(() => root.render(<RecentCalls api={fakeApi(state)} />));
    await click(copy.t("history.open"));
    expect(document.activeElement?.textContent).toBe(copy.t("history.title"));
    expect(host.textContent).toContain("Ben");
    expect(host.textContent).toContain(copy.t("history.nobody"));
    const offers = [...host.querySelectorAll("button")].filter((b) => b.textContent === copy.t("safety.open"));
    expect(offers).toHaveLength(1);
    expect(offers[0]?.getAttribute("aria-label")).toBe(copy.t("safety.openLabel", { name: "Ben" }));
    await click(copy.t("safety.openLabel", { name: "Ben" }));
    expect(host.querySelector("dialog h2")?.textContent).toBe(copy.t("safety.title", { name: "Ben" }));
    await click(copy.t("safety.block.button", { name: "Ben" }));
    await click(copy.t("safety.confirm.block"));
    expect(state.requests).toEqual(["block c1"]);
    expect(host.textContent).toContain(copy.t("history.blocked"));
  });
});

describe("blocked people", () => {
  it("lists them, and unblocks with a status line saying so", async () => {
    const state = { blocked: [{ contactId: "c1", displayName: "Ben", blockedAt: 1 }], reports: [], requests: [] as string[] };
    act(() => root.render(<BlockedPeople api={fakeApi(state)} />));
    await click(copy.t("blocked.open"));
    await click(copy.t("blocked.unblockLabel", { name: "Ben" }));
    expect(state.requests).toEqual(["unblock c1"]);
    expect(host.querySelector("[role=status]")?.textContent).toBe(copy.t("blocked.unblocked", { name: "Ben" }));
    expect(host.textContent).toContain(copy.t("blocked.empty"));
  });
});

describe("the owner's reports", () => {
  it("shows the reason, both names, the details, and marks one reviewed", async () => {
    const report: OwnerReport = {
      id: "r1",
      reason: "hate",
      details: "slurs",
      status: "open",
      createdAt: 1_800_000_000_000,
      reviewedAt: null,
      reporter: null,
      reported: { userId: "u2", displayName: "Ben" },
    };
    const state = { blocked: [], reports: [report], requests: [] as string[] };
    act(() => root.render(<OwnerReports api={fakeApi(state)} />));
    await click(copy.t("reports.open"));
    const text = host.textContent ?? "";
    expect(text).toContain(copy.t("safety.reason.hate"));
    expect(text).toContain(copy.t("reports.from", { name: copy.t("reports.deletedAccount") }));
    expect(text).toContain(copy.t("reports.about", { name: "Ben" }));
    expect(text).toContain("slurs");
    await click(copy.t("reports.markReviewed"));
    expect(state.requests).toEqual(["review r1"]);
    expect(host.textContent).toContain(copy.t("reports.status.reviewed"));
  });
});
