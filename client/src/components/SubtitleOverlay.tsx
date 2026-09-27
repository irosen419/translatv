import { useEffect, useRef, useState } from "react";
import type { RenderedLine } from "@translatv/shared";
import { failureCopyKey } from "../i18n/codes.js";
import { useCopy } from "../i18n/useCopy.js";
import { liveCaptionFor } from "../lib/caption.js";

/**
 * How long a settled line stays up once nobody is talking.
 *
 * A subtitle is for reading something just said. Leaving the last sentence up until someone
 * happens to say the next one means it sits over the video for the rest of the call, which is
 * what this is: a caption that outstays its sentence, not a caption that is missing.
 */
const FADE_AFTER_MS = 3_000;

interface Props {
  /** The most recent finalized line from the peer, or null. */
  line: RenderedLine | null;
  /** Live, still being spoken. Updates several times a second. */
  interimText: string;
  /**
   * The reader's own dialect, which decides which row goes on top.
   *
   * This surface only ever shows the PEER talking, so in practice the translation stays on top
   * and nothing here moves. It is threaded through anyway because the alternative is a caption
   * call that quietly cannot answer the question the other two surfaces answer.
   */
  viewerDialect: string | null;
}

/**
 * The subtitle overlay: the reader's own language LARGE on top, the other SMALL and italic
 * beneath. Since this surface only renders the peer talking, that is the translation on top.
 *
 * The interim line is written straight to the DOM through a ref rather than going through
 * React state. That is a deliberate break from the model, and the reason is measurable: interim
 * results arrive at roughly 5 per second, and re-rendering this subtree that often next to a
 * playing video element drops frames. Finalized lines go through normal state, where a render
 * per sentence is nothing.
 *
 * The write MUST be textContent, never innerHTML. This is user speech from another person, and
 * innerHTML here would be a direct XSS injection point from anything they said.
 */
export function SubtitleOverlay({ line, interimText, viewerDialect }: Props) {
  const interimRef = useRef<HTMLParagraphElement>(null);
  const copy = useCopy();

  useEffect(() => {
    const node = interimRef.current;
    if (!node) return;
    // textContent, NEVER innerHTML. See the note above.
    node.textContent = interimText;
  }, [interimText]);

  // Fading is tracked here rather than by dropping the line, so the text stays in place and the
  // layout does not jump. Coming back is immediate: a fade in would hide the start of the next
  // sentence, which is the part you most need.
  const [faded, setFaded] = useState(false);

  // Deliberately keyed on the scalars that change what is ON SCREEN, not on the line object.
  // `line` is derived per render from the whole transcript, so its identity changes whenever
  // anything is added, including your OWN speech, and depending on it would keep the peer's last
  // sentence up for as long as you kept talking.
  const lineId = line?.lineId;
  const revision = line?.revision;
  const translated = line?.translated;
  const translationStatus = line?.translationStatus;

  useEffect(() => {
    setFaded(false);
    // Someone is mid sentence: hold it, there is more coming.
    if (interimText) return;
    if (!lineId) return;
    const timer = setTimeout(() => setFaded(true), FADE_AFTER_MS);
    return () => clearTimeout(timer);
    // A translation landing after the sentence restarts the clock, so the three seconds are three
    // seconds of having something readable rather than three seconds of watching a spinner.
  }, [lineId, revision, translated, translationStatus, interimText]);

  // While someone is mid sentence, the live original is the bottom line and the top waits. Once
  // the sentence settles, the translation takes the top and the original settles below it.
  //
  // The waiting is liveCaptionFor's job now. This used to render the settled caption regardless,
  // so the top held the PREVIOUS sentence's translation over the live words of the current one.
  const caption = liveCaptionFor(line, interimText, viewerDialect);

  return (
    // aria-hidden once faded, so a screen reader is not still offering a sentence that is no
    // longer on screen for everyone else.
    <div className={`subtitles${faded ? " faded" : ""}`} aria-hidden={faded}>
      <p
        className={[
          "translated",
          caption.pendingRow === "primary" ? "pending" : "",
          caption.untranslated ? "failed" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {caption.primary}
        {caption.untranslated && (
          // The marker says a translation is missing. WHY it is missing rides along as a
          // tooltip, from the code the server sent: before this the reason was written in
          // English on the server and thrown away by the client, so nothing on screen ever
          // explained a failure to the person watching it.
          <span
            className="marker"
            title={line?.failureReason ? copy.t(failureCopyKey(line.failureReason)) : ""}
          >
            {copy.t("caption.notTranslated")}
          </span>
        )}
        {/* A note, not a marker. Nothing failed here, so it must not borrow the warning colour
            that means something did. */}
        {caption.noteKey && <span className="note">{copy.t(caption.noteKey)}</span>}
      </p>

      {interimText ? (
        <p ref={interimRef} className="original live" />
      ) : (
        <p className="original">{caption.secondary}</p>
      )}
    </div>
  );
}
