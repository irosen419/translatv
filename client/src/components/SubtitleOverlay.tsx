import { useEffect, useRef, useState, type RefObject } from "react";
import type { RenderedLine } from "@translatv/shared";
import type { Copy } from "../i18n/copy.js";
import { failureCopyKey } from "../i18n/codes.js";
import { useCopy } from "../i18n/useCopy.js";
import { holdFor, subtitleFor, type Caption, type SubtitleView } from "../lib/caption.js";

interface Props {
  /**
   * The peer's newest finalized line and newest settled one, as one value straight from
   * peerLinesFor. One prop rather than two, so nothing between here and there can swap them.
   */
  peer: { newest: RenderedLine | null; settled: RenderedLine | null };
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
export function SubtitleOverlay({ peer, interimText, viewerDialect }: Props) {
  const interimRef = useRef<HTMLParagraphElement>(null);
  const copy = useCopy();

  useEffect(() => {
    const node = interimRef.current;
    if (!node) return;
    // textContent, NEVER innerHTML. See the note above.
    node.textContent = interimText;
  }, [interimText]);

  // Every decision lives in lib/caption.ts, where it is a plain function with tests, and the
  // markup in SubtitleBlock below, which is hook free so a test can call it. What is left here is
  // the wiring a node test cannot reach: the timer, and remembering what was last on screen.
  const clock = holdFor(peer.settled, viewerDialect);
  const [expiredKey, setExpiredKey] = useState<string | null>(null);

  // On the key and the duration ONLY. Anything that changes while the peer talks, interim text
  // above all, would restart the clock on every word and the held line would never fade.
  useEffect(() => {
    const { key, ms } = clock;
    if (!key) {
      // Nothing settled: a retry has sent the line back to pending. Forget the expiry, or a retry
      // that fails the same way again comes back with the very key that already expired (the
      // client's failure handler does not move the revision) and is never shown, marker and all.
      setExpiredKey(null);
      return;
    }
    const timer = setTimeout(() => setExpiredKey(key), ms);
    return () => clearTimeout(timer);
  }, [clock.key, clock.ms]);

  // The caption last committed to the screen, which is what a hidden block fades out with.
  // Written after commit rather than during render, so a render React throws away cannot leave
  // behind a caption nobody saw.
  const lastShown = useRef<Caption | null>(null);
  const view = subtitleFor({
    ...peer,
    heldExpired: clock.key === null || expiredKey === clock.key,
    interimText,
    viewerDialect,
    previous: lastShown.current,
  });
  useEffect(() => {
    if (view.captionShown) lastShown.current = view.caption;
  });

  return (
    <SubtitleBlock
      view={view}
      copy={copy}
      failureTitle={
        peer.settled?.failureReason ? copy.t(failureCopyKey(peer.settled.failureReason)) : ""
      }
      interimRef={interimRef}
    />
  );
}

export interface SubtitleBlockProps {
  view: SubtitleView;
  copy: Copy;
  /** Why the held line's translation is missing, for the marker's tooltip. Empty for none. */
  failureTitle: string;
  /** Where interim speech is written, outside React. See SubtitleOverlay. */
  interimRef: RefObject<HTMLParagraphElement>;
}

/**
 * The markup, hook free on purpose, the same way SelfControlButton is: calling it is an ordinary
 * function call and the tree it hands back is plain data a test can read without a DOM.
 */
export function SubtitleBlock({ view, copy, failureTitle, interimRef }: SubtitleBlockProps) {
  const { caption, captionShown, live, faded } = view;
  return (
    // aria-hidden once faded, so a screen reader is not still offering a sentence that is no
    // longer on screen for everyone else. Fading is tracked rather than done by dropping the
    // text, so nothing on screen jumps. Coming back is immediate: a fade in would hide the start
    // of the next sentence, which is the part you most need.
    <div className={`subtitles${faded ? " faded" : ""}`} aria-hidden={faded}>
      <div className={`held${captionShown ? "" : " faded"}`} aria-hidden={!captionShown}>
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
            <span className="marker" title={failureTitle}>
              {copy.t("caption.notTranslated")}
            </span>
          )}
          {/* A note, not a marker. Nothing failed here, so it must not borrow the warning colour
              that means something did. */}
          {caption.noteKey && <span className="note">{copy.t(caption.noteKey)}</span>}
        </p>
        <p className="original">{caption.secondary}</p>
      </div>

      {/* Its OWN row, below the pair and never inside it. Written through the ref while it is
          interim speech, for the frame rate reason above; a finished sentence waiting on its
          translation changes once, so it renders normally. */}
      {live && !live.pending && <p ref={interimRef} className="live" />}
      {live?.pending && <p className="live pending">{live.text}</p>}
    </div>
  );
}
