// Transcript export and import.
//
// The export carries the glossary alongside the conversation, which is what makes corrections
// compound across sessions without a database: the user holds the file, and loading it at the
// start of the next call restores everything they taught the translator last time.
//
// TXT and JSON ONLY. There is deliberately no HTML export, and that is a security decision
// rather than a scope one. A participant types a script tag into chat, it round trips into a
// downloaded .html, the other person opens it from file://, and it executes with access to
// their local files. A .txt cannot do that.

import type { GlossaryEntry, RenderedLine } from "@translatv/shared";
import type { Copy, CopyRef } from "../i18n/copy.js";

export const EXPORT_VERSION = 1;

export interface TranscriptExport {
  version: number;
  exportedAt: string;
  roomCode: string;
  participants: string[];
  lines: Array<{
    at: string;
    speaker: string;
    dialect: string;
    original: string;
    translated: string | null;
    source: "speech" | "chat";
  }>;
  glossary: GlossaryEntry[];
}

export function buildExport(input: {
  roomCode: string;
  lines: readonly RenderedLine[];
  glossary: readonly GlossaryEntry[];
  nameFor(memberId: string): string;
}): TranscriptExport {
  const participants = [...new Set(input.lines.map((l) => input.nameFor(l.from)))];
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    roomCode: input.roomCode,
    participants,
    lines: input.lines.map((line) => ({
      at: line.ts,
      speaker: input.nameFor(line.from),
      dialect: line.srcDialect,
      original: line.text,
      // An untranslated line exports as null rather than as its original text, so a reader
      // cannot mistake a failure for a translation that happened to match.
      translated: line.translationStatus === "ok" ? line.translated : null,
      source: line.source,
    })),
    glossary: [...input.glossary],
  };
}

/**
 * Render the readable export.
 *
 * Takes the reader's copy rather than reaching for it, for the same reason every other pure
 * module here takes its dependencies: this is the one function in the file that produces
 * sentences, and a file someone downloads should be in the language they were reading the call
 * in. The .json export is deliberately NOT localized: it is data, it round trips back through
 * parseImport, and translating its field names would break every file already on disk.
 */
export function toPlainText(data: TranscriptExport, copy: Copy): string {
  const lines: string[] = [
    copy.t("export.header", { code: data.roomCode }),
    copy.t("export.exportedAt", { when: new Date(data.exportedAt).toLocaleString() }),
    data.participants.length > 0
      ? copy.t("export.participants", { names: data.participants.join(", ") })
      : "",
    "",
  ];

  for (const line of data.lines) {
    const time = new Date(line.at).toLocaleTimeString();
    lines.push(`[${time}] ${line.speaker} (${line.dialect}):`);
    if (line.translated) {
      lines.push(`  ${line.translated}`);
      lines.push(`  ${copy.t("export.original", { text: line.original })}`);
    } else {
      lines.push(`  ${line.original}`);
      lines.push(`  ${copy.t("export.notTranslated")}`);
    }
    lines.push("");
  }

  if (data.glossary.length > 0) {
    lines.push(copy.t("export.glossary"), "");
    for (const entry of data.glossary) {
      lines.push(`  ${entry.source}  ->  ${entry.target}`);
    }
  }

  return lines.join("\n");
}

/**
 * Trigger a download.
 *
 * text/plain and application/json only, never text/html, for the reason at the top of this
 * file. The Blob type is what the browser honors when the file is later opened locally.
 */
export function download(filename: string, contents: string, kind: "txt" | "json"): void {
  const type = kind === "json" ? "application/json" : "text/plain";
  const blob = new Blob([contents], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export type ImportResult =
  | { ok: true; glossary: GlossaryEntry[]; lineCount: number }
  | { ok: false; notice: CopyRef };

/**
 * Parse a previously exported transcript back into a glossary.
 *
 * Validates defensively: this file came off a user's disk and may have been hand edited, be
 * from a future version, or not be one of ours at all. A clear message beats a stack trace,
 * because the person seeing it is trying to start a call.
 */
export function parseImport(raw: string): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, notice: { key: "import.notJson" } };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, notice: { key: "import.notExport" } };
  }

  const data = parsed as Partial<TranscriptExport>;
  if (typeof data.version !== "number") {
    return { ok: false, notice: { key: "import.notExport" } };
  }
  if (data.version > EXPORT_VERSION) {
    return { ok: false, notice: { key: "import.tooNew" } };
  }
  if (!Array.isArray(data.glossary)) {
    return { ok: false, notice: { key: "import.noGlossary" } };
  }

  const glossary: GlossaryEntry[] = [];
  for (const entry of data.glossary) {
    if (
      typeof entry?.source === "string" &&
      typeof entry?.target === "string" &&
      entry.source.trim() &&
      entry.target.trim()
    ) {
      glossary.push({
        source: entry.source,
        target: entry.target,
        sourceDialect: typeof entry.sourceDialect === "string" ? entry.sourceDialect : "en-US",
        targetDialect: typeof entry.targetDialect === "string" ? entry.targetDialect : "en-US",
      });
    }
  }

  if (glossary.length === 0) {
    return { ok: false, notice: { key: "import.noUsable" } };
  }

  return {
    ok: true,
    glossary,
    lineCount: Array.isArray(data.lines) ? data.lines.length : 0,
  };
}
