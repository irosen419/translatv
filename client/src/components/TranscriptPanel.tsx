import { useEffect, useRef, useState } from "react";
import { LIMITS, TERM_MAX_WORDS, type Member, type RenderedLine } from "@translatv/shared";
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
import { canCorrect, correctionDraft, correctionProblem, willBeSaved } from "../lib/correction.js";
import { failureCopyKey } from "../i18n/codes.js";
import { useCopy } from "../i18n/useCopy.js";

interface Props {
  lines: readonly RenderedLine[];
  selfId: string | null;
  me: Member | null;
  peer: Member | null;
  // No transcript download any more (owner decision 2026-09-28): nobody downloads the chat. The
  // .txt and .json buttons, and canExport with them, are gone.
  /** A term level correction (owner decision C1): a phrase from the line, and its fix. */
  onCorrect(lineId: string, phrase: string, fix: string): void;
  onRetry(lineId: string): void;
  onSendChat(text: string): void;
}

export function TranscriptPanel(props: Props) {
  const { lines, selfId, me, peer } = props;
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

  return (
    <aside className="panel">
      <div className="panel-head">
        <span>{copy.t("panel.title")}</span>
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
                {/* Only on the other person's lines (owner decision C2): the fix is for the
                    translation you read, and your own line is shown to you as you said it. */}
                {canCorrect(line, selfId) && (
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
          onClose={() => setCorrecting(null)}
          onSave={(phrase, fix) => {
            props.onCorrect(correcting.lineId, phrase, fix);
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

/**
 * A term level correction (owner decision C1, 2026-10-09): the words that came out wrong, and
 * how they should read. Both fields start from the line, the whole of what they said and the
 * whole translation, for the person to trim. A phrase that is the whole line replaces the line's
 * translation; a shorter one applies from the next line on. Either way it is saved to this
 * person's account when the call ends.
 *
 * The limits are not maxLength attributes: a prefilled line can be longer than a term, and a
 * maxLength would neither cut it nor say why Save does nothing. The problem is said in words
 * instead, under the fields, and Save waits for it to be fixed.
 */
function CorrectionDialog({
  line,
  onClose,
  onSave,
}: {
  line: RenderedLine;
  onClose(): void;
  onSave(phrase: string, fix: string): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => correctionDraft(line));
  // Said only after the first try, so a dialog that opens on a whole long line does not greet the
  // person with an error before they have touched it.
  const [tried, setTried] = useState(false);
  const copy = useCopy();
  const problem = correctionProblem(draft.phrase, draft.fix, line.text);
  const shown = tried ? problem : null;
  // Which field the problem is in, for aria-invalid. An empty pair can be either, or both.
  const phraseBad =
    shown !== null &&
    (shown === "correct.problem.empty" ? draft.phrase.trim() === "" : shown !== "correct.problem.fixTooLong");
  const fixBad =
    shown !== null &&
    (shown === "correct.problem.empty" ? draft.fix.trim() === "" : shown === "correct.problem.fixTooLong");

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="correction-title">
      <h2 id="correction-title">{copy.t("correct.title")}</h2>
      <p>{copy.t("correct.body")}</p>

      <div className="field">
        <span className="label">{copy.t("correct.theySaid")}</span>
        <div className="correction-original" lang={line.srcDialect}>
          {line.text}
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setTried(true);
          if (problem === null) onSave(draft.phrase.trim(), draft.fix.trim());
        }}
      >
        <div className="field">
          <label htmlFor="correction-phrase">{copy.t("correct.phrase")}</label>
          <textarea
            id="correction-phrase"
            rows={2}
            lang={line.srcDialect}
            value={draft.phrase}
            onChange={(event) => setDraft((d) => ({ ...d, phrase: event.target.value }))}
            aria-describedby={[
              "correction-hint",
              !willBeSaved(draft.phrase) && draft.phrase.trim() !== "" ? "correction-not-saved" : null,
              shown ? "correction-problem" : null,
            ]
              .filter(Boolean)
              .join(" ")}
            aria-invalid={phraseBad || undefined}
            autoFocus
          />
          <p id="correction-hint" className="hint">
            {copy.t("correct.phrase.hint")}
          </p>
          {/* Not a problem: it still fixes this call. Said as the person types, so pressing Save on
              the untouched whole line is a choice they can see the outcome of. */}
          <div aria-live="polite">
            {!willBeSaved(draft.phrase) && draft.phrase.trim() !== "" && (
              <p id="correction-not-saved" className="hint">
                {copy.t("correct.notSaved", { max: TERM_MAX_WORDS })}
              </p>
            )}
          </div>
        </div>

        <div className="field">
          <label htmlFor="correction-fix">{copy.t("correct.shouldSay")}</label>
          <textarea
            id="correction-fix"
            rows={2}
            value={draft.fix}
            onChange={(event) => setDraft((d) => ({ ...d, fix: event.target.value }))}
            aria-describedby={shown ? "correction-problem" : undefined}
            aria-invalid={fixBad || undefined}
          />
        </div>

        {shown && (
          <p id="correction-problem" className="hint bad" role="alert">
            {copy.t(shown, { max: shown === "correct.problem.fixTooLong" ? LIMITS.glossaryTranslation : LIMITS.glossaryTerm })}
          </p>
        )}

        <div className="row">
          <button type="button" onClick={() => ref.current?.close()} style={{ flex: "0 0 auto" }}>
            {copy.t("correct.cancel")}
          </button>
          <button type="submit" className="primary">
            {copy.t("correct.save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
