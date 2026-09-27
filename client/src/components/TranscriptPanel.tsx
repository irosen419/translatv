import { useEffect, useRef, useState } from "react";
import type { GlossaryEntry, Member, RenderedLine } from "@translatv/shared";
import { captionFor } from "../lib/caption.js";
import {
  DRAFT_MAX,
  clampToCap,
  draftLength,
  pasteInsertion,
  placeholderVisible,
  submittableText,
  textToInsert,
} from "../lib/composer.js";
import { buildExport, download, toPlainText } from "../lib/transcript.js";
import { failureCopyKey } from "../i18n/codes.js";
import { useCopy } from "../i18n/useCopy.js";

interface Props {
  lines: readonly RenderedLine[];
  glossary: readonly GlossaryEntry[];
  selfId: string | null;
  me: Member | null;
  peer: Member | null;
  roomCode: string;
  /**
   * May this reader download the conversation?
   *
   * A UX affordance, NOT access control, and the difference matters enough to say twice. This
   * reader's browser already holds every line, because it needs them to render their own
   * subtitles, so anyone who opens devtools has the whole conversation whatever this says.
   * Hiding the buttons keeps a feature out of a guest's way; it does not keep anything from
   * them. Nothing downstream should be built as though it did.
   */
  canExport: boolean;
  onCorrect(lineId: string, corrected: string): void;
  onRetry(lineId: string): void;
  onSendChat(text: string): void;
}

export function TranscriptPanel(props: Props) {
  const { lines, glossary, selfId, me, peer, roomCode, canExport } = props;
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [correcting, setCorrecting] = useState<RenderedLine | null>(null);
  const copy = useCopy();
  // One string for the aria label, the inert attribute and the visible prompt, so the three
  // cannot drift. It comes from the copy files rather than a module constant, so it follows the
  // dialect picker like everything else.
  const prompt = copy.t("composer.placeholder");

  // Composer state. The field is a contenteditable, so React does NOT render its children: it
  // would fight the caret on every keystroke. The draft mirrors the field's textContent, and the
  // only writes back into the node are clearing it and cutting it to the cap.
  const field = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // The field's height with nothing in it, measured once. Anything taller means it has wrapped.
  const oneLine = useRef(0);

  // Stick to the bottom, but only when the reader is already there. Yanking someone back down
  // while they are reading scrollback is worse than a slightly stale view.
  function pinIfNearBottom(): void {
    const node = scroller.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }

  useEffect(pinIfNearBottom, [lines]);

  // The composer grows UPWARD, taking its height out of the transcript above it. That means the
  // scroller gets shorter without its content or its scrollTop changing, so a reader who was
  // pinned to the bottom silently stops being pinned. Re-pin on every resize of the field, under
  // the same near the bottom rule the lines effect uses.
  useEffect(() => {
    const node = field.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => pinIfNearBottom());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Measure the empty field once.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    oneLine.current = node.clientHeight;
  }, []);

  // Inert on a div (a div has no native placeholder), so it changes nothing on screen. It is
  // here because it is the handle anything that looks this field up by its prompt text uses,
  // the e2e suite included. Keyed on the prompt so it follows a dialect change rather than
  // keeping whatever language was current when the panel mounted.
  useEffect(() => {
    field.current?.setAttribute("placeholder", prompt);
  }, [prompt]);

  // Refuse an insertion that would pass the cap, rather than accepting it and cutting the draft
  // back afterwards.
  //
  // readField's clamp is still the backstop, but on its own it was the wrong behavior for the
  // ordinary case: at the cap, typing in the MIDDLE of a draft let the character in, then cut
  // the last character off the end to pay for it and moved the caret there. The writer lost a
  // character they were not looking at and their cursor jumped out of the word they were in.
  //
  // A native listener rather than React's onBeforeInput, whose synthetic version does not carry
  // the inputType this needs. Composition is left alone: an input method mid sequence owns the
  // field, and refusing its events is how dead keys and accents break, which is not a trade
  // worth making in a Spanish first app for a cap the backstop already holds.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    function guard(event: InputEvent): void {
      if (!node || event.isComposing) return;
      if (!event.inputType.startsWith("insert")) return;
      // Paste and drop have their own handlers, which size the insertion against the room left.
      if (event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop") return;
      const incoming = event.data ?? "";
      if (incoming.length === 0) return;
      const selected = draftLength(window.getSelection()?.toString() ?? "");
      const after = draftLength(node.textContent ?? "") - selected + draftLength(incoming);
      if (after > DRAFT_MAX) event.preventDefault();
    }
    node.addEventListener("beforeinput", guard);
    return () => node.removeEventListener("beforeinput", guard);
  }, []);

  /** Pull the draft out of the field, enforcing the cap a contenteditable cannot enforce itself. */
  function readField(): void {
    const node = field.current;
    if (!node) return;
    // textContent, NEVER innerHTML. This field holds typed text on its way to another person,
    // and innerHTML here would turn a pasted script tag into a node rather than characters.
    const text = node.textContent ?? "";
    const capped = clampToCap(text);
    if (capped !== text) {
      // Assigning a string to textContent replaces the children with ONE text node. It does not
      // parse markup, which is the whole reason the cap is enforced this way.
      node.textContent = capped;
      placeCaretAtEnd(node);
    }
    setDraft(capped);
    // Re-measure the baseline whenever the field is empty, so a web font that arrives after the
    // first measurement cannot leave a one line draft reading as wrapped forever.
    if (capped.length === 0) oneLine.current = node.clientHeight;
    setExpanded(node.scrollHeight > oneLine.current + 2);
  }

  /**
   * Put text into the field at the caret, as ONE TEXT NODE.
   *
   * Written by hand rather than with execCommand("insertText"), which was the first attempt: the
   * browser turns an inserted newline into a block element, and textContent then reads the two
   * lines back joined with no newline between them, so the draft that got sent was not the draft
   * on screen. A text node keeps the field a flat run of characters, which is also what keeps
   * reading it with textContent honest. It cannot introduce an element, so markup stays
   * characters no matter where it came from.
   */
  function insertPlainText(text: string): void {
    const node = field.current;
    if (!node || !text) return;
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (selection && range && node.contains(range.commonAncestorContainer)) {
      // Is there anything after the caret? Measured before the insertion, because whether the
      // caret is at the end changes what gets inserted. See textToInsert.
      const tail = document.createRange();
      tail.selectNodeContents(node);
      tail.setStart(range.endContainer, range.endOffset);
      const atEnd = tail.toString().length === 0;

      range.deleteContents();
      const inserted = document.createTextNode(textToInsert(text, atEnd));
      range.insertNode(inserted);
      range.setStart(inserted, text.length);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      // No caret inside the field, so append rather than guess at a position.
      node.textContent = (node.textContent ?? "") + text;
      placeCaretAtEnd(node);
    }
    // A scripted mutation fires no input event, so the draft is refreshed by hand.
    readField();
  }

  function sendDraft(): void {
    const text = submittableText(draft);
    if (!text) return;
    props.onSendChat(text);
    setDraft("");
    setExpanded(false);
    const node = field.current;
    if (node) node.textContent = "";
  }

  function nameFor(memberId: string): string {
    if (memberId === selfId) return me?.username ?? copy.t("room.you");
    if (memberId === peer?.id) return peer.username;
    return copy.t("panel.someone");
  }

  function exportTranscript(kind: "txt" | "json"): void {
    const data = buildExport({ roomCode, lines, glossary, nameFor });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    if (kind === "json") {
      download(`chat-${roomCode}-${stamp}.json`, JSON.stringify(data, null, 2), "json");
    } else {
      download(`chat-${roomCode}-${stamp}.txt`, toPlainText(data, copy), "txt");
    }
  }

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>{copy.t("panel.title")}</span>
        <span className="spacer" />
        {canExport && (
          <>
            <button onClick={() => exportTranscript("txt")} title={copy.t("panel.export.txt")}>
              .txt
            </button>
            <button onClick={() => exportTranscript("json")} title={copy.t("panel.export.json")}>
              .json
            </button>
          </>
        )}
      </div>

      <div className="transcript" ref={scroller}>
        {lines.length === 0 && (
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
            {copy.t("panel.empty")}
          </p>
        )}

        {lines.map((line) => {
          const mine = line.from === selfId;
          // Whether the small original row is worth showing is captionFor's decision, not this
          // component's. Deciding it here is how the two presentations drifted: the panel knew
          // about "skipped" and nothing else, so a FAILED line (translated is set to its own
          // text on purpose, so the screen is never blank) printed the same sentence twice.
          const caption = captionFor(line, me?.dialect ?? null);
          const failed =
            line.translationStatus === "unavailable" ||
            line.translationStatus === "rate_limited" ||
            line.translationStatus === "budget_exceeded";

          return (
            <div key={line.lineId} className={`line${mine ? " mine" : ""}`}>
              <div className="who">
                {nameFor(line.from)}
                {line.source === "chat" ? ` ${copy.t("panel.typed")}` : ""}
              </div>

              {/* Both rows come from captionFor now. This block used to reach past it for the
                  prominent row and print `line.translated ?? line.text` by hand, which is exactly
                  the drift that file exists to prevent: the panel kept the translation on top for
                  EVERYONE, so the person who spoke read their own sentence as the small italic
                  footnote under a translation they cannot check. */}
              <div className={caption.pendingRow === "primary" ? "t pending" : "t"}>
                {caption.pendingRow === "primary" ? copy.t("panel.translating") : caption.primary}
                {/* Same quiet aside the overlays show. The panel is where someone scrolls back
                    to work out why a line reads the way it does, so leaving it out here would
                    hide the explanation in the one place it is most likely to be looked for. */}
                {caption.noteKey && <span className="note">{copy.t(caption.noteKey)}</span>}
              </div>

              {/* The small italic row exists to keep the OTHER language visible beside the one
                  the reader reads. When the row above already holds both (a skipped line, or a
                  failed one showing its own text), repeating it makes the line nobody could
                  translate look like the noisiest thing on screen. */}
              {caption.secondary && (
                <div className={caption.pendingRow === "secondary" ? "o pending" : "o"}>
                  {caption.pendingRow === "secondary"
                    ? copy.t("panel.translating")
                    : caption.secondary}
                </div>
              )}

              <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                {!failed && line.translationStatus === "ok" && (
                  <button className="fix" onClick={() => setCorrecting(line)}>
                    {copy.t("panel.fix")}
                  </button>
                )}
                {failed && (
                  // The reason rides on the retry button rather than taking a row of its own.
                  // It is the control the reason is ABOUT, the panel is already dense, and a
                  // whole sentence per failed line would drown the conversation it explains.
                  <button
                    className="fix"
                    title={line.failureReason ? copy.t(failureCopyKey(line.failureReason)) : ""}
                    onClick={() => props.onRetry(line.lineId)}
                  >
                    {copy.t("panel.retry")}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* The field wraps and grows instead of scrolling sideways, which an input cannot do. It
          grows upward into the transcript, capped by a max height in the stylesheet so it can
          never swallow the conversation it is growing into. */}
      <form
        className={expanded ? "composer expanded" : "composer"}
        onSubmit={(event) => {
          event.preventDefault();
          sendDraft();
        }}
      >
        <div className="composer-field-wrap">
          <div
            ref={field}
            className="composer-field"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={prompt}
            tabIndex={0}
            onInput={readField}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              // Mid composition, Enter belongs to the input method (accents and dead keys are
              // everyday here), so it is not ours to take.
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (event.shiftKey) {
                insertPlainText("\n");
                return;
              }
              sendDraft();
            }}
            onPaste={(event) => {
              // A paste is the one gesture that can carry markup, or 2000 characters, in one go.
              // Read text/plain only and insert it as text, so neither can land in the field.
              event.preventDefault();
              const node = field.current;
              if (!node) return;
              insertPlainText(
                pasteInsertion({
                  draftLength: draftLength(node.textContent ?? ""),
                  selectionLength: draftLength(window.getSelection()?.toString() ?? ""),
                  pasted: event.clipboardData.getData("text/plain"),
                }),
              );
            }}
            onDrop={(event) => {
              // A drop inserts NODES, and there is no text/plain only form of it. Refused
              // outright: the field takes typed and pasted text, and nothing else.
              event.preventDefault();
            }}
          />
          {/* Custom placeholder, not the native one: it leaves on focus rather than on the first
              keystroke, and comes back on blur while the field is still empty. Hidden from
              assistive tech because aria-label already names the field. */}
          {placeholderVisible(draft, focused) && (
            <span className="composer-placeholder" aria-hidden="true">
              {prompt}
            </span>
          )}
        </div>
        <button type="submit" disabled={submittableText(draft) === null}>
          {copy.t("composer.send")}
        </button>
      </form>

      {correcting && (
        <CorrectionDialog
          line={correcting}
          mine={correcting.from === selfId}
          onClose={() => setCorrecting(null)}
          onSave={(text) => {
            props.onCorrect(correcting.lineId, text);
            setCorrecting(null);
          }}
        />
      )}
    </aside>
  );
}

/** Put the caret back at the end, after the draft was cut to the cap under the writer. */
function placeCaretAtEnd(node: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function CorrectionDialog({
  line,
  mine,
  onClose,
  onSave,
}: {
  line: RenderedLine;
  /** You are the one who spoke it, so the original row is your own words, not theirs. */
  mine: boolean;
  onClose(): void;
  onSave(text: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState(line.translated ?? "");
  const copy = useCopy();

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onClose={onClose}>
      <h2>{copy.t("correct.title")}</h2>
      <p>{copy.t("correct.body")}</p>

      <div className="field">
        <label>{copy.t(mine ? "correct.youSaid" : "correct.theySaid")}</label>
        <div
          style={{
            background: "var(--panel-2)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "9px 11px",
            fontStyle: "italic",
            fontSize: 14,
          }}
        >
          {line.text}
        </div>
      </div>

      <div className="field">
        <label htmlFor="correction">{copy.t("correct.shouldSay")}</label>
        <input
          id="correction"
          value={text}
          onChange={(event) => setText(event.target.value)}
          maxLength={400}
          autoFocus
        />
      </div>

      <div className="row">
        <button type="button" onClick={() => ref.current?.close()} style={{ flex: "0 0 auto" }}>
          {copy.t("correct.cancel")}
        </button>
        <button
          type="button"
          className="primary"
          disabled={!text.trim()}
          onClick={() => onSave(text.trim())}
        >
          {copy.t("correct.save")}
        </button>
      </div>
    </dialog>
  );
}
