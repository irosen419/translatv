import { describe, expect, it } from "vitest";

import { copyFor } from "../i18n/copy.js";
import { INFO_PAGES, pageFromPath, splitPlaceholders } from "./pages.js";

describe("pageFromPath", () => {
  it("reads the two public pages, with or without a trailing slash", () => {
    expect(pageFromPath("/privacy")).toBe("privacy");
    expect(pageFromPath("/privacy/")).toBe("privacy");
    expect(pageFromPath("/support")).toBe("support");
  });

  it("is null for everything else, a room link included", () => {
    for (const path of ["/", "/r/ABCD-1234", "/privacyx", "/support/more", "/Privacy", ""]) {
      expect(pageFromPath(path)).toBeNull();
    }
  });
});

describe("splitPlaceholders", () => {
  it("separates the owner's blanks from the prose around them", () => {
    expect(splitPlaceholders("Run by [OWNER: operator name], in [OWNER: jurisdiction].")).toEqual([
      { text: "Run by ", placeholder: false },
      { text: "[OWNER: operator name]", placeholder: true },
      { text: ", in ", placeholder: false },
      { text: "[OWNER: jurisdiction]", placeholder: true },
      { text: ".", placeholder: false },
    ]);
  });

  it("leaves a line with none as one piece", () => {
    expect(splitPlaceholders("Plain.")).toEqual([{ text: "Plain.", placeholder: false }]);
  });
});

describe("INFO_PAGES", () => {
  it("asks only for keys that exist, so no line renders as a missing key", () => {
    const keys = new Set(copyFor("en-US").all().map(([key]) => key));
    for (const page of Object.values(INFO_PAGES)) {
      expect(keys.has(page.title)).toBe(true);
      for (const section of page.sections) {
        expect(keys.has(section.heading)).toBe(true);
        for (const block of section.blocks) {
          const asked = block.kind === "list" ? block.items : block.kind === "contact" ? [block.withEmail, block.withoutEmail] : [block.key];
          for (const key of asked) expect(keys.has(key)).toBe(true);
        }
      }
    }
  });

  it("says the numbers the code enforces, from the constants rather than typed in", () => {
    const copy = copyFor("en-US");
    const glossary = INFO_PAGES.privacy.sections.flatMap((s) => s.blocks).flatMap((b) => (b.kind === "list" ? b.items : []));
    expect(glossary).toContain("privacy.stores.glossary");
    expect(copy.t("privacy.stores.glossary", INFO_PAGES.privacy.params)).toContain("6 words or fewer");
    expect(copy.t("privacy.stores.glossary", INFO_PAGES.privacy.params)).toContain("up to 40 terms");
    expect(copy.t("privacy.stores.reports", INFO_PAGES.privacy.params)).toContain("up to 500 characters");
  });
});
