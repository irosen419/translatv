// How one transcript line becomes two rows of text.
//
// Extracted so the desktop subtitle overlay and the mobile conversation overlay cannot drift.
// They are two presentations of the same decision, and when this logic lived inside the subtitle
// component the only way to add a second presentation was to copy it.

import { languageOf } from "@translatv/shared";
import type { RenderedLine, SkipReason } from "@translatv/shared";
import type { CopyKey } from "../i18n/copy.js";

export interface Caption {
  /**
   * The prominent row: whichever of the two texts is in the READER's own language.
   *
   * Which one that is depends on who spoke, so the same line is arranged differently on the two
   * screens showing it. That is the point. A caption exists to be read, and the row the reader
   * can actually read is the row that belongs on top.
   */
  primary: string;
  /** The quieter row beneath, empty when it would only repeat the row above. */
  secondary: string;
  /** Translation failed. The reader needs telling, because silence looks like agreement. */
  untranslated: boolean;
  /**
   * Which row is still waiting on the model, or null because nothing is.
   *
   * A row rather than a boolean, because the waiting row is not always the prominent one. On
   * your OWN line the words are known instantly and it is the outgoing translation that is in
   * flight, so a plain "this caption is pending" would hand the muted, still-loading styling to
   * the one row that is already final.
   */
  pendingRow: "primary" | "secondary" | null;
  /**
   * A quiet aside explaining why a line carries no translation, null when there is nothing
   * worth saying.
   *
   * A copy KEY rather than a sentence, so the surface rendering it resolves the words in the
   * reader's own dialect. This module's job is deciding WHICH note applies, not what it says.
   *
   * NOT the same thing as `untranslated`, and deliberately styled apart from it. `untranslated`
   * means something FAILED and offers a retry; this means nothing was attempted and nothing went
   * wrong, and the reader would just like to know which of the harmless reasons applied.
   */
  noteKey: CopyKey | null;
}

const EMPTY: Caption = {
  primary: "",
  secondary: "",
  untranslated: false,
  pendingRow: null,
  noteKey: null,
};

/**
 * What a skipped line says for itself, if anything.
 *
 * Silent for same_language on purpose: two people who share a language do not need telling that
 * their own sentence was not translated into their own language, and a note on every line would
 * be noise on the most ordinary case there is.
 *
 * The other two are worth a word. "Your peer is reading you untranslated" and "there is nobody
 * here yet" are facts a reader cannot deduce from an untranslated line, and the absence of any
 * mark is exactly what made all three look like the app quietly not working.
 *
 * Both phrasings are true from EITHER side of the call, which matters because this same caption
 * renders your own lines and theirs.
 *
 * KEYS, not sentences. This module decides WHICH note applies; the surface that renders it looks
 * the words up in the reader's own dialect. Returning English here would have been the one place
 * in the app where a caption argued with the interface around it.
 */
const SKIP_NOTES: Record<SkipReason, CopyKey | null> = {
  same_language: null,
  recipient_off: "caption.translationOff",
  no_peer: "caption.nobodyHere",
};

/**
 * How long a settled subtitle stays up, from the moment it has something readable.
 *
 * Reading time, not a flat timer. This was 3 seconds for every line, which is plenty for "yes"
 * and nowhere near enough for a twenty word answer: the reader was still on the first half when
 * it faded. So the floor stays at the old 3 seconds and longer lines buy more, at 300 ms a word,
 * which is about 200 words a minute: a comfortable pace for subtitles read over a moving picture
 * by someone who is also watching a face. The ceiling exists because a monologue would otherwise
 * park its subtitle over the video until it is no longer the thing being talked about.
 *
 * Counted in words of the row the reader actually reads, which is the prominent one.
 */
export const HOLD_MIN_MS = 3_000;
export const HOLD_BASE_MS = 1_500;
export const HOLD_PER_WORD_MS = 300;
export const HOLD_MAX_MS = 10_000;

export function holdMsFor(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, HOLD_BASE_MS + words * HOLD_PER_WORD_MS));
}

/**
 * The reading clock for the held line: what restarts it, and how long it runs.
 *
 * Keyed on the scalars that change what that line SAYS, not on the line object: lines are derived
 * per render from the whole transcript, so their identity changes whenever anything is added,
 * including your OWN speech, and depending on it would restart the clock for as long as you kept
 * talking. A translation landing, a correction, or a retry changes the key, so the reading time is
 * time with something readable on screen rather than time spent watching an ellipsis.
 *
 * Nothing about the words being spoken now goes in, and that is the fix: the peer starting their
 * next sentence must not restart the clock. Taking only the line keeps it out of the key by
 * construction. The timer that runs on the key has to keep it out too; see SubtitleOverlay.
 */
export function holdFor(
  settled: RenderedLine | null,
  viewerDialect: string | null,
): { key: string | null; ms: number } {
  if (!settled) return { key: null, ms: 0 };
  return {
    key: `${settled.lineId}:${settled.revision}:${settled.translationStatus}:${settled.translated ?? ""}`,
    ms: holdMsFor(captionFor(settled, viewerDialect).primary),
  };
}

/**
 * The two peer lines the desktop subtitle needs.
 *
 * `newest` is the peer's latest finalized line, whatever state its translation is in. `settled`
 * is the latest one whose translation is no longer in flight (landed, failed, or skipped), which
 * is the line worth holding on screen. They differ exactly while a sentence is waiting on the
 * model, and that window is where the overlay used to throw away a translation the reader had
 * not finished.
 */
export function peerLinesFor(
  lines: readonly RenderedLine[],
  selfId: string | null,
): { newest: RenderedLine | null; settled: RenderedLine | null } {
  let newest: RenderedLine | null = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const candidate = lines[i];
    if (!candidate || candidate.from === selfId) continue;
    newest ??= candidate;
    if (candidate.translationStatus !== "pending") return { newest, settled: candidate };
    // A retry puts a line that had already settled back to pending, and it keeps the text it
    // settled with (the failure fallback), which a line that never settled does not have. Walking
    // past it would hand back an OLDER line as the one to hold, and bring a sentence the reader had
    // already finished back on screen for a full hold, in place of the one they asked to retry.
    // A line that settled once is as far back as this looks.
    if (candidate.translated !== null) return { newest, settled: null };
  }
  return { newest, settled: null };
}

export interface SubtitleView {
  /**
   * The two row block: a sentence's prominent row with its OWN other row beneath. The pair is
   * never split, which is what makes it safe to keep a sentence up while the next one is spoken.
   */
  caption: Caption;
  /**
   * Whether the block is on screen. False keeps it IN PLACE but invisible, so a held line can
   * fade where it stands rather than collapsing and pulling the live row up under the reader.
   */
  captionShown: boolean;
  /**
   * A row beneath the block for something that is not that sentence: words still being spoken,
   * or a finished sentence whose translation is in flight (`pending`). Null when there is none.
   */
  live: { text: string; pending: boolean } | null;
  /** The scrim goes, only when there is nothing left to read at all: no block and no live row. */
  faded: boolean;
}

/**
 * What the desktop subtitle shows.
 *
 * The rule: a translation stays up until the reader has had time to read it (`heldExpired`,
 * timed by the caller from holdMsFor) or a newer one replaces it. The peer starting their next
 * sentence is NEITHER of those. It used to blank the top row on the spot, so in an ordinary back
 * and forth a translation was on screen for the moment between landing and the next word, and
 * often never at all, while the side panel showed it fine. That is the "they disappear too soon"
 * a caller reported.
 *
 * The blanking was there for a real reason, and the reason still holds. Stacking the PREVIOUS
 * sentence's translation directly over the live words of the current one presents it as a
 * translation of them, and it is not one. So the held sentence keeps its own original beneath it,
 * and the live words get a separate row of their own below the pair, the same shape the mobile
 * overlay already uses for them.
 */
export function subtitleFor(input: {
  newest: RenderedLine | null;
  settled: RenderedLine | null;
  heldExpired: boolean;
  interimText: string;
  viewerDialect: string | null;
  /**
   * The caption the block last SHOWED, or null if it never showed one. A hidden block fades out
   * with this, because the fade is the tail of what was on screen. Fading anything else puts a
   * sentence on screen for the length of the fade that was not there a moment before.
   */
  previous: Caption | null;
}): SubtitleView {
  const { newest, settled, heldExpired, interimText, viewerDialect, previous } = input;
  const held = settled && !heldExpired ? settled : null;
  const waiting = newest && newest !== settled ? newest : null;

  if (held) {
    // The newest words win the live row. A sentence that is only waiting on its translation is
    // the older of the two, and it reaches the screen anyway, as the held line, once it lands.
    const live = interimText
      ? { text: interimText, pending: false }
      : waiting
        ? { text: waiting.text, pending: true }
        : null;
    return { caption: captionFor(held, viewerDialect), captionShown: true, live, faded: false };
  }

  const live = interimText ? { text: interimText, pending: false } : null;

  // Nothing worth holding, and a sentence in flight with nobody talking over it: the ellipsis on
  // top and the words beneath, as before. While someone IS talking, the top waits.
  if (waiting && !live) {
    return {
      caption: captionFor(waiting, viewerDialect),
      captionShown: true,
      live: null,
      faded: false,
    };
  }

  // Hidden, but still handed back, so it fades where it stands. It is the caption last SHOWN and
  // not one derived from the lines now, which can be a different sentence: with a held line
  // expired and the next one waiting, the block showed the waiting ellipsis, and the moment the
  // peer started talking this used to swap in the expired line and fade THAT, putting a sentence
  // the reader had already finished back over the live words for the length of the fade.
  return { caption: previous ?? EMPTY, captionShown: false, live, faded: live === null };
}

/**
 * Whether this line was spoken in the reader's own language.
 *
 * Compared by BASE LANGUAGE, not by dialect code. An es-AR speaker reading their own line back
 * after switching the picker to es-MX is still reading their own language, and an en-GB reader
 * facing an en-US speaker is too.
 *
 * Answers false rather than guessing when either code is unresolvable, which is the same honesty
 * rule translationNeed follows and for the same reason. False keeps the arrangement this function
 * had before it could tell the two cases apart: the translation on top. Getting it wrong in the
 * other direction would bury the only row the reader can read, under a language they do not have.
 */
function inReaderLanguage(line: RenderedLine, viewerDialect: string | null): boolean {
  if (!viewerDialect) return false;
  const spoken = languageOf(line.srcDialect);
  const reader = languageOf(viewerDialect);
  if (spoken === null || reader === null) return false;
  return spoken === reader;
}

/**
 * Split a line into the rows a caption shows, arranged for the person reading it.
 *
 * `viewerDialect` is required rather than optional on purpose. Three surfaces render captions,
 * and an optional argument would let any of them keep the old reader-blind arrangement silently.
 */
export function captionFor(line: RenderedLine | null, viewerDialect: string | null): Caption {
  if (!line) return EMPTY;
  const status = line.translationStatus;

  // Nothing was translated and nothing went wrong, so the words take the prominent row and the
  // quiet row stays empty. No marker either: a marker means something failed, and nothing did.
  // A NOTE is not a marker: it says which harmless reason this was, and an unknown reason says
  // nothing at all rather than guessing one of the three.
  if (status === "skipped") {
    return {
      primary: line.text,
      secondary: "",
      untranslated: false,
      pendingRow: null,
      noteKey: line.skipReason ? SKIP_NOTES[line.skipReason] : null,
    };
  }

  const pending = status === "pending";
  const translation = line.translated ?? (pending ? "..." : "");

  // The two rows, then the reader decides which is on top. When the reader spoke this line the
  // words are theirs and the translation is the outgoing one, so the ellipsis on a pending line
  // lands on the quiet row: your own sentence is known the moment you say it, and covering it
  // with a spinner waiting on a translation you are not the one reading helps nobody.
  const own = inReaderLanguage(line, viewerDialect);
  const primary = own ? line.text : translation;
  const beneath = own ? translation : line.text;

  return {
    primary,
    // Dropped when it would only repeat the row above, which is the contract stated on the
    // field. This is not a theoretical case: a FAILED line has translated set to its own text
    // on purpose, by RoomSession.setFailed on the server and by the translation.failed handler
    // in the client store, so the screen shows the words rather than a blank row or a spinner
    // that never resolves. Without this the overlay rendered that same sentence large and then
    // again small italic beneath it, which is the default view of every line on a server with
    // no ANTHROPIC_API_KEY, meaning every automated run.
    secondary: beneath === primary ? "" : beneath,
    untranslated:
      status === "unavailable" || status === "rate_limited" || status === "budget_exceeded",
    // The translation is the row that waits, so it is whichever row the translation landed in.
    pendingRow: pending ? (own ? "secondary" : "primary") : null,
    // Only a skipped line has a note. A failure already carries a marker and a retry button, and
    // a translated line has nothing to explain.
    noteKey: null,
  };
}
