import { describe, expect, it } from "vitest";
import type { GlossaryEntry, RenderedLine } from "@translatv/shared";
import { copyFor } from "../i18n/copy.js";
import { buildExport, EXPORT_VERSION, parseImport, toPlainText } from "./transcript.js";

/** The English copy, so the assertions below stay about the words a reader sees. */
const english = copyFor("en-US");

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    lineId: "L1",
    from: "m1",
    srcDialect: "en-US",
    text: "do you have time tomorrow",
    source: "speech",
    ts: "2026-07-31T10:00:00.000Z",
    translated: "tenes tiempo manana",
    translationStatus: "ok",
    revision: 1,
    skipReason: null,
    ...overrides,
  };
}

const nameFor = (id: string) => (id === "m1" ? "Ana" : "Ben");

describe("buildExport", () => {
  it("carries the glossary alongside the conversation", () => {
    // This is what makes corrections compound across sessions without a database: the user
    // holds the file, and loading it next time restores what they taught the translator.
    const glossary: GlossaryEntry[] = [
      { source: "standup", target: "la daily", sourceDialect: "en-US", targetDialect: "es-AR" },
    ];
    const data = buildExport({ roomCode: "ABCD1234", lines: [line()], glossary, nameFor });
    expect(data.glossary).toHaveLength(1);
    expect(data.version).toBe(EXPORT_VERSION);
  });

  it("exports an untranslated line as null, not as its original text", () => {
    // Otherwise a reader cannot tell a failure from a translation that happened to match, and
    // a re-import would treat the original as a confirmed rendering.
    const data = buildExport({
      roomCode: "ABCD1234",
      lines: [line({ translationStatus: "unavailable", translated: "do you have time tomorrow" })],
      glossary: [],
      nameFor,
    });
    expect(data.lines[0]?.translated).toBeNull();
    expect(data.lines[0]?.original).toBe("do you have time tomorrow");
  });

  it("lists the participants it saw", () => {
    const data = buildExport({
      roomCode: "ABCD1234",
      lines: [line(), line({ lineId: "L2", from: "m2" })],
      glossary: [],
      nameFor,
    });
    expect(data.participants).toEqual(["Ana", "Ben"]);
  });
});

describe("toPlainText", () => {
  it("puts the translation above the original, matching the on screen order", () => {
    const data = buildExport({ roomCode: "ABCD1234", lines: [line()], glossary: [], nameFor });
    const text = toPlainText(data, english);
    expect(text.indexOf("tenes tiempo manana")).toBeLessThan(
      text.indexOf("original: do you have time tomorrow"),
    );
  });

  it("marks an untranslated line rather than leaving it ambiguous", () => {
    const data = buildExport({
      roomCode: "ABCD1234",
      lines: [line({ translationStatus: "unavailable" })],
      glossary: [],
      nameFor,
    });
    expect(toPlainText(data, english)).toContain("not translated");
  });
});

describe("parseImport", () => {
  function exported(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: EXPORT_VERSION,
      exportedAt: "2026-07-31T10:00:00.000Z",
      roomCode: "ABCD1234",
      participants: ["Ana"],
      lines: [],
      glossary: [
        { source: "standup", target: "la daily", sourceDialect: "en-US", targetDialect: "es-AR" },
      ],
      ...overrides,
    });
  }

  it("round trips a real export", () => {
    const result = parseImport(exported());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.glossary[0]?.target).toBe("la daily");
  });

  it("explains itself when given the .txt by mistake", () => {
    // The likeliest user error: two files were downloaded and only one is loadable.
    const result = parseImport("Conversation from room ABCD1234\n\n[10:00] Ana:");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(english.ref(result.notice)).toContain(".txt");
  });

  it("refuses a newer version rather than misreading it", () => {
    const result = parseImport(exported({ version: EXPORT_VERSION + 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(english.ref(result.notice)).toContain("newer version");
  });

  it("rejects a file that is not one of ours", () => {
    const result = parseImport(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
  });

  it("drops malformed entries instead of failing the whole import", () => {
    // A hand edited file should give up its usable entries rather than all of them.
    const result = parseImport(
      exported({
        glossary: [
          { source: "good", target: "bueno", sourceDialect: "en-US", targetDialect: "es-AR" },
          { source: "", target: "empty source" },
          { nothing: "useful" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.glossary).toHaveLength(1);
  });

  it("supplies dialect defaults for an entry missing them", () => {
    const result = parseImport(exported({ glossary: [{ source: "a", target: "b" }] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.glossary[0]?.sourceDialect).toBe("en-US");
  });

  it("says so when an export has no corrections in it", () => {
    const result = parseImport(exported({ glossary: [] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(english.ref(result.notice)).toContain("no usable corrections");
  });
});
