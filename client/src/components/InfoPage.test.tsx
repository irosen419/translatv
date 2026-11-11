// @vitest-environment happy-dom
//
// The public privacy and support pages, rendered: one h1, sections under it in order, the draft
// notice when (and only when) the page is a draft, the owner's blanks marked so nobody mistakes
// them for finished prose, and the support address as a working mailto link or not at all.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { copyFor } from "../i18n/copy.js";
import { useStore } from "../state/store.js";
import { InfoPage, SiteLinks } from "./InfoPage.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const copy = copyFor("en-US");
let host: HTMLDivElement;
let root: Root;

function render(page: "privacy" | "support", draft = false): void {
  act(() => root.render(<InfoPage page={page} draft={draft} />));
}

beforeEach(() => {
  useStore.setState({ uiDialect: "en-US", supportEmail: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the privacy page", () => {
  it("has one h1, and every heading steps down at most one level", () => {
    render("privacy");
    const headings = [...host.querySelectorAll("h1, h2, h3")];
    expect(host.querySelectorAll("h1")).toHaveLength(1);
    expect(headings[0]?.textContent).toBe(copy.t("privacy.title"));
    let level = 1;
    for (const heading of headings.slice(1)) {
      const next = Number(heading.tagName.slice(1));
      expect(next).toBeLessThanOrEqual(level + 1);
      level = next;
    }
  });

  it("shows the draft notice only when told it is a draft", () => {
    render("privacy", true);
    expect(host.querySelector(".doc-draft")?.textContent).toBe(copy.t("page.draft"));
    render("privacy", false);
    expect(host.querySelector(".doc-draft")).toBeNull();
  });

  it("marks every owner placeholder, so a blank cannot pass for prose", () => {
    render("privacy");
    const marked = [...host.querySelectorAll("mark.owner-placeholder")].map((m) => m.textContent);
    expect(marked).toContain("[OWNER: operator name]");
    expect(marked.length).toBeGreaterThan(5);
    // Every [OWNER: ...] on the page is inside a mark.
    const unmarked = (host.textContent ?? "").match(/\[OWNER:[^\]]*\]/g)?.length ?? 0;
    expect(unmarked).toBe(marked.length);
  });

  it("names the support address as the contact when there is one, and the blank when there is none", () => {
    render("privacy");
    expect(host.querySelector("a[href^='mailto:']")).toBeNull();
    expect(host.textContent).toContain("[OWNER: a contact address for privacy questions.");
    act(() => useStore.setState({ supportEmail: "help@example.test" }));
    expect(host.querySelector("a[href^='mailto:']")?.getAttribute("href")).toBe("mailto:help@example.test");
  });

  it("links back to the app", () => {
    render("privacy");
    expect(host.querySelector("a[href='/']")?.textContent).toBe(copy.t("site.back"));
  });

  it("renders in the reader's language", () => {
    act(() => useStore.setState({ uiDialect: "es-AR" }));
    render("privacy");
    expect(host.querySelector("h1")?.textContent).toBe(copyFor("es-AR").t("privacy.title"));
  });
});

describe("the support page", () => {
  it("never shows the privacy draft notice, whatever it is told", () => {
    render("support", true);
    expect(host.querySelector(".doc-draft")).toBeNull();
  });

  it("offers a mailto link when the server has an address, and says who to ask when it has none", () => {
    render("support");
    expect(host.querySelector("a[href^='mailto:']")).toBeNull();
    expect(host.textContent).toContain(copy.t("support.help.without"));
    act(() => useStore.setState({ supportEmail: "help@example.test" }));
    expect(host.querySelector("a[href^='mailto:']")?.getAttribute("href")).toBe("mailto:help@example.test");
    expect(host.textContent).not.toContain(copy.t("support.help.without"));
  });

  it("covers reporting, deleting and the common fixes", () => {
    render("support");
    const titles = [...host.querySelectorAll("h2, h3")].map((h) => h.textContent);
    for (const key of ["support.safety.h", "support.delete.h", "support.media.h", "support.stt.h", "support.net.h"] as const) {
      expect(titles).toContain(copy.t(key));
    }
  });
});

describe("the links to these pages", () => {
  it("points at both pages, and at support by mail only when there is an address", () => {
    act(() => root.render(<SiteLinks />));
    const hrefs = () => [...host.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs()).toEqual(["/privacy", "/support"]);
    act(() => useStore.setState({ supportEmail: "help@example.test" }));
    expect(hrefs()).toEqual(["/privacy", "/support", "mailto:help@example.test"]);
    expect(host.querySelector("nav")?.getAttribute("aria-label")).toBe(copy.t("site.links"));
  });
});
