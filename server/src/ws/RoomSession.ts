// Per room runtime state that is deliberately NOT in RoomManager.
//
// RoomManager is pure with respect to time and IO so its edge cases are testable. This holds
// the mutable conversation state that has nothing to do with lifecycle: the transcript, the
// glossary, and the rolling context window. Keeping them apart is what stops the lifecycle
// tests from needing a transcript, and stops a transcript bug from being a lifecycle bug.
//
// Everything here dies with the room. Nothing is written to disk, which is the privacy promise.

import type {
  GlossaryEntry,
  RenderedLine,
  SkipReason,
  TranslationStatus,
} from "@translatv/shared";
import type { ContextTurn } from "../translate/prompt.js";
import { CONTEXT_TURNS, GLOSSARY_MAX } from "../translate/prompt.js";

/**
 * How many finalized lines to keep.
 *
 * A cap is needed because a room is memory that a client controls the growth of, and an hour of
 * fast talking is a few thousand lines. The client keeps its own full copy for the download, so
 * trimming here costs a late joiner some scrollback and costs nobody their transcript.
 */
export const MAX_LINES = 500;

let lineCounter = 0;

export class RoomSession {
  private readonly lines: RenderedLine[] = [];
  private readonly glossary: GlossaryEntry[] = [];
  private readonly context: ContextTurn[] = [];

  nextLineId(): string {
    lineCounter += 1;
    return `L${lineCounter}`;
  }

  addLine(input: {
    from: string;
    username: string;
    srcDialect: string;
    text: string;
    source: "speech" | "chat";
    /**
     * What the line starts as. Defaults to "pending" because most lines are about to be
     * translated, but a line nobody will translate is born "skipped" rather than created pending
     * and corrected a frame later. That keeps "pending" meaning one thing, a translation is
     * genuinely in flight, instead of meaning "we have not decided yet".
     */
    translationStatus?: TranslationStatus;
    /**
     * Why it was skipped, for a line born skipped. Travels ON the line because that line gets no
     * second frame: without it the reason the caller already knows dies here, and the client has
     * to render three different situations the same way.
     */
    skipReason?: SkipReason;
  }): RenderedLine {
    const line: RenderedLine = {
      lineId: this.nextLineId(),
      from: input.from,
      srcDialect: input.srcDialect,
      text: input.text,
      source: input.source,
      ts: new Date().toISOString(),
      translated: null,
      translationStatus: input.translationStatus ?? "pending",
      revision: 0,
      skipReason: input.skipReason ?? null,
    };

    this.lines.push(line);
    if (this.lines.length > MAX_LINES) this.lines.shift();

    this.context.push({
      username: input.username,
      dialect: input.srcDialect,
      text: input.text,
    });
    if (this.context.length > CONTEXT_TURNS) this.context.shift();

    return line;
  }

  find(lineId: string): RenderedLine | null {
    return this.lines.find((l) => l.lineId === lineId) ?? null;
  }

  setTranslation(lineId: string, text: string, status: TranslationStatus): RenderedLine | null {
    const line = this.find(lineId);
    if (!line) return null;
    line.translated = text;
    line.translationStatus = status;
    // A line that HAS a translation was not skipped, whatever it used to be. Leaving the reason
    // behind would render a note explaining why this line was not translated, underneath its
    // translation.
    line.skipReason = null;
    line.revision += 1;
    return line;
  }

  /**
   * Mark a line as needing no translation. Used by the retry path only, since a fresh line is
   * born skipped. Leaves `translated` null: there is no translation, and copying the original
   * into that slot is what the FAILURE path does to keep the text visible. Doing it here would
   * make a skip indistinguishable from a failure to every reader downstream.
   */
  setSkipped(lineId: string, reason: SkipReason): RenderedLine | null {
    const line = this.find(lineId);
    if (!line) return null;
    line.translated = null;
    line.translationStatus = "skipped";
    line.skipReason = reason;
    line.revision += 1;
    return line;
  }

  setFailed(
    lineId: string,
    // "skipped" is excluded on purpose: nothing was attempted, so it is not a failure and must
    // not be reachable through the failure path.
    status: Exclude<TranslationStatus, "ok" | "skipped">,
  ): RenderedLine | null {
    const line = this.find(lineId);
    if (!line) return null;
    // The failure fallback: show the ORIGINAL text where the translation goes, marked. Never a
    // blank line, and never a spinner that resolves to nothing.
    line.translated = line.text;
    line.translationStatus = status;
    // A failure is not a skip. Carrying a stale reason here would put a quiet "nothing needed
    // translating" note on a line that very much did and could not be.
    line.skipReason = null;
    line.revision += 1;
    return line;
  }

  /** Context for the next translation, excluding the line being translated. */
  contextFor(excludeText: string): readonly ContextTurn[] {
    const turns = [...this.context];
    if (turns.length > 0 && turns[turns.length - 1]?.text === excludeText) turns.pop();
    return turns;
  }

  /**
   * Record a correction and apply it to the line.
   *
   * The correction is BOTH a glossary entry (so future translations of the same phrase honor
   * it) and a direct override of this line (so the fix is visible immediately, with no second
   * API call). Doing only the first would leave the wrong text on screen; only the second would
   * make the user correct the same term over and over.
   */
  correct(lineId: string, corrected: string, targetDialect: string): RenderedLine | null {
    const line = this.find(lineId);
    if (!line) return null;

    this.addGlossaryEntry({
      source: line.text,
      target: corrected,
      sourceDialect: line.srcDialect,
      targetDialect,
    });

    line.translated = corrected;
    line.translationStatus = "ok";
    line.skipReason = null;
    line.revision += 1;
    return line;
  }

  addGlossaryEntry(entry: GlossaryEntry): void {
    // Most recently used first, deduplicated on the source phrase, so correcting the same term
    // twice replaces rather than accumulates.
    const existing = this.glossary.findIndex(
      (e) => e.source.toLowerCase() === entry.source.toLowerCase(),
    );
    if (existing !== -1) this.glossary.splice(existing, 1);
    this.glossary.unshift(entry);
    if (this.glossary.length > GLOSSARY_MAX) this.glossary.length = GLOSSARY_MAX;
  }

  importGlossary(entries: readonly GlossaryEntry[]): void {
    // Reversed so the incoming order survives the unshift in addGlossaryEntry.
    for (const entry of [...entries].reverse()) this.addGlossaryEntry(entry);
  }

  get glossaryEntries(): readonly GlossaryEntry[] {
    return this.glossary;
  }

  /** A snapshot for a joining or resuming client, so they see the conversation so far. */
  snapshot(): { lines: RenderedLine[]; glossary: GlossaryEntry[] } {
    return { lines: [...this.lines], glossary: [...this.glossary] };
  }
}
