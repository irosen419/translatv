import { useEffect, useRef, useState } from "react";
import type { RenderedLine } from "@translatv/shared";
import { captionFor } from "../lib/caption.js";
import { failureCopyKey } from "../i18n/codes.js";
import { useCopy } from "../i18n/useCopy.js";

interface Props {
  lines: readonly RenderedLine[];
  selfId: string | null;
  /** The peer's live, still being spoken text. Updates several times a second. */
  interimText: string;
  /** The reader's own dialect, which decides which row of a line goes on top. */
  viewerDialect: string | null;
  onSendChat(text: string): void;
}

/**
 * The mobile conversation overlay: subtitles and chat as ONE surface over the bottom of the video.
 *
 * Kept separate from the desktop side panel on purpose. The two used to be a subtitle overlay and
 * a transcript panel competing for the same strip of a phone screen, which meant the newest
 * sentence rendered twice, once large and once in the log. Here the newest line IS the subtitle:
 * it takes the large row, and everything older shrinks into scrollback above it.
 *
 * Left aligned throughout. Centred text reads fine as a single caption but badly as a log, where
 * every line starting at a different x is what makes a wall of text hard to skim.
 *
 * The interim line is written straight to the DOM through a ref rather than through React state,
 * for the same measured reason as the desktop overlay: interim results arrive at roughly 5 per
 * second and re-rendering this subtree that often beside a playing video drops frames. The write
 * MUST be textContent, never innerHTML. This is another person's speech, and innerHTML here would
 * be a direct injection point from anything they said.
 */
export function ConversationOverlay({
  lines,
  selfId,
  interimText,
  viewerDialect,
  onSendChat,
}: Props) {
  const interimRef = useRef<HTMLParagraphElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const copy = useCopy();

  useEffect(() => {
    const node = interimRef.current;
    if (!node) return;
    // textContent, NEVER innerHTML. See the note above.
    node.textContent = interimText;
  }, [interimText]);

  // Stick to the bottom, but only when the reader is already there. Yanking someone back down
  // while they are reading scrollback is worse than a slightly stale view.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [lines, interimText]);

  const newest = lines.length > 0 ? lines[lines.length - 1]! : null;
  const older = lines.slice(0, -1);
  const caption = captionFor(newest, viewerDialect);

  return (
    <div className="conversation">
      <div className="conversation-log" ref={scroller}>
        {older.map((line) => {
          const past = captionFor(line, viewerDialect);
          return (
            <p key={`${line.lineId}:${line.revision}`} className="past-line">
              <span className="who">
                {line.from === selfId ? copy.t("overlay.you") : copy.t("overlay.them")}
              </span>
              <span className="said">{past.primary || past.secondary}</span>
            </p>
          );
        })}

        {newest && (
          <div className="current-line">
            <p
              className={[
                "translated",
                caption.pendingRow === "primary" ? "pending" : "",
                caption.untranslated ? "failed" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {/* Labelled, unlike the desktop subtitle. That one only ever shows the PEER, so
                  there is nothing to disambiguate. This log carries both sides, and the newest
                  line is the one you most need to attribute. */}
              <span className="who">
                {newest.from === selfId ? copy.t("overlay.you") : copy.t("overlay.them")}
              </span>
              {caption.primary}
              {caption.untranslated && (
                <span
                  className="marker"
                  title={
                    newest.failureReason ? copy.t(failureCopyKey(newest.failureReason)) : ""
                  }
                >
                  {copy.t("caption.notTranslated")}
                </span>
              )}
              {caption.noteKey && <span className="note">{copy.t(caption.noteKey)}</span>}
            </p>
            {caption.secondary && (
              <p
                className={
                  caption.pendingRow === "secondary" ? "original pending" : "original"
                }
              >
                {caption.secondary}
              </p>
            )}
          </div>
        )}

        {/* The peer's live speech is its OWN row at the bottom, not the second row of whatever
            line happens to be newest. Hung off the newest line it read as the original text of
            that line, which is wrong the moment the newest line is one of YOURS: their half
            spoken sentence would appear captioned as what you just said. */}
        {interimText && <p ref={interimRef} className="interim-line" />}

        {/* Only reachable before anyone has said anything, so it explains the silence rather than
            leaving an empty black strip that looks like a rendering failure. */}
        {!newest && !interimText && (
          <p className="conversation-empty">{copy.t("overlay.empty")}</p>
        )}
      </div>

      <form
        className="conversation-composer"
        onSubmit={(event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) return;
          onSendChat(text);
          setDraft("");
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={copy.t("composer.placeholder")}
          maxLength={2000}
          aria-label={copy.t("composer.placeholder")}
        />
        <button type="submit" disabled={!draft.trim()}>
          {copy.t("composer.send")}
        </button>
      </form>
    </div>
  );
}
