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
 * The caption a LIVE subtitle should show while someone may still be talking.
 *
 * A non-empty interim is speech that has not been finalized, so it is strictly newer than the
 * settled line handed in beside it. That makes the settled line the PREVIOUS sentence, and
 * stacking its translation directly above the words being spoken now presents it as a
 * translation OF those words. It is not one. The two rows were routinely different sentences:
 * a Spanish reader saw the translation of what was said a moment ago sitting on top of the live
 * English of what is being said right now, with nothing to say they were unrelated.
 *
 * So the top waits, which is what the subtitle overlay always claimed to do and never did. An
 * empty row for the moment between sentences is honest; a confidently wrong pairing is not.
 *
 * The whole caption goes, not just its text. A failure marker left standing over live words
 * accuses the sentence being spoken of a failure that belonged to the last one.
 */
export function liveCaptionFor(
  line: RenderedLine | null,
  interimText: string,
  viewerDialect: string | null,
): Caption {
  return captionFor(interimText ? null : line, viewerDialect);
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
