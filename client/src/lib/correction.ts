// Term level corrections, the client's half (owner decisions C1 and C2, 2026-10-09).
//
// The dialog asks for a phrase from the line and its fix, prefilled with the whole line and its
// translation for the person to trim. The server applies the same rules (ws/server.ts,
// handleCorrect, and RoomSession.correct) and refuses quietly, so each one is checked here first,
// where there is someone to tell.

import { LIMITS, phraseInLine, samePhrase, type ClientMessage, type RenderedLine } from "@translatv/shared";
import type { CopyKey } from "../i18n/copy.js";

/**
 * Whether this reader may correct this line: someone else's line, with a translation to fix.
 *
 * Only the other person's lines (decision C2), because the fix is for the translation you read.
 * Your own line is shown to you as you said it, and a correction of it made an entry from your
 * dialect into your own, which no translation ever reads. Unknown `selfId` offers nothing.
 */
export function canCorrect(line: RenderedLine, selfId: string | null): boolean {
  return selfId !== null && line.from !== selfId && line.translationStatus === "ok";
}

export function correctionDraft(line: RenderedLine): { phrase: string; fix: string } {
  return { phrase: line.text, fix: line.translated ?? "" };
}

/** What stops this correction being sent, as the copy key that says so, or null. */
export function correctionProblem(phrase: string, fix: string, lineText: string): CopyKey | null {
  const p = phrase.trim();
  const f = fix.trim();
  if (p.length === 0 || f.length === 0) return "correct.problem.empty";
  if (p.length > LIMITS.glossaryTerm) return "correct.problem.phraseTooLong";
  if (f.length > LIMITS.glossaryTranslation) return "correct.problem.fixTooLong";
  if (!phraseInLine(p, lineText)) return "correct.problem.notInLine";
  if (samePhrase(p, f)) return "correct.problem.same";
  return null;
}

export function correctionMessage(lineId: string, phrase: string, fix: string): Extract<ClientMessage, { t: "glossary.correct" }> {
  return { t: "glossary.correct", lineId, source: phrase.trim(), correctedTranslation: fix.trim() };
}
