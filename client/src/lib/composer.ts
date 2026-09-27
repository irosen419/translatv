// The decisions behind the chat composer.
//
// The composer field is a contenteditable rather than an input, because an input cannot wrap or
// grow and a long message scrolled sideways out of view. A contenteditable buys wrapping and
// costs three things the browser used to hand us for free: a character cap (there is no
// maxLength attribute), a placeholder, and a guarantee that what lands in the field is text.
// Those three decisions live here, as pure functions, so they can be unit tested without a DOM
// and so the component stays a thin shell. Same reasoning as caption.ts.
//
// SECURITY: the draft is only ever read with textContent and only ever written as a text node.
// Nothing in this module produces markup, and nothing that calls it may set innerHTML. A
// contenteditable is a direct injection surface, and this app renders other people's words.

import { LIMITS } from "@translatv/shared";

/**
 * The cap, taken from the wire contract rather than restated here.
 *
 * protocol.ts decides what the server will accept, so a number of our own beside it is a second
 * truth that drifts silently. When it drifts the writer loses a message: the client calls the
 * draft sendable, the field clears, and the frame is refused with nothing on screen to say so.
 */
export const DRAFT_MAX = LIMITS.chat;

/**
 * Is the custom placeholder showing?
 *
 * Deliberately NOT the native behavior. A native placeholder survives focus and only leaves on
 * the first keystroke. This one leaves the moment the field is focused and comes back when the
 * field is blurred while still empty, which is what the owner asked for.
 *
 * Empty means no characters at all. A lone space is a draft: the caret has moved and hiding the
 * prompt text is the only way the caret is not sitting on top of it.
 */
export function placeholderVisible(draft: string, focused: boolean): boolean {
  return !focused && draft.length === 0;
}

/**
 * The text a submit should send, or null when there is nothing to send.
 *
 * One function for both questions, so the Send button's disabled state and the submit handler
 * cannot disagree about what counts as empty. Whitespace only stays non submittable, exactly as
 * it was with the input, and that now includes a draft of nothing but newlines from shift plus
 * enter. Interior newlines survive, because the field is multi line on purpose.
 */
export function submittableText(draft: string): string | null {
  const text = draft.trim();
  return text.length === 0 ? null : text;
}

/**
 * Cut a draft down to the cap.
 *
 * Two different things, and getting either wrong loses a message.
 *
 * It WALKS code points, so a cut can never land between the halves of a surrogate pair and leave
 * a replacement character behind. This app is bilingual and full of characters above the BMP.
 *
 * It MEASURES in UTF-16 units, because that is what the server counts: protocol.ts refines on
 * `v.length`, which is units. Measuring in points instead let 1200 emoji (1200 points, 2400
 * units) pass here and be refused there, so Send enabled, Enter cleared the field, and the
 * message simply never arrived.
 *
 * A pair that does not fit is left out entirely rather than half admitted, which is why this
 * stops on the first point that would overshoot instead of slicing a count of points.
 */
export function clampToCap(text: string, cap: number = DRAFT_MAX): string {
  if (text.length <= cap) return text;
  let out = "";
  for (const point of text) {
    if (out.length + point.length > cap) break;
    out += point;
  }
  return out;
}

/**
 * How much a string costs against the cap.
 *
 * UTF-16 units, the same thing the server counts and the same thing clampToCap measures. All
 * three have to agree or the arithmetic that decides how much room a paste has is wrong.
 */
export function draftLength(text: string): number {
  return text.length;
}

/**
 * Normalize something on its way into the field.
 *
 * Callers read the clipboard as text/plain and pass it here, so markup arrives as characters and
 * stays characters: this function never parses it and never returns nodes. It flattens line
 * endings, turns tabs into spaces (a tab in a chat line is noise the reader cannot see), and
 * drops control characters, which would otherwise sit invisibly in the draft and travel over the
 * wire. Newlines are kept, since the field is multi line.
 */
export function toPlainDraft(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    // C0 and C1 controls, newline excepted. Written as ranges around \n so the intent is legible.
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, "");
}

export interface PasteInsertion {
  /** Characters currently in the field. */
  draftLength: number;
  /** Characters the paste is about to replace. */
  selectionLength: number;
  /** The clipboard's text/plain payload, unnormalized. */
  pasted: string;
  cap?: number;
}

/**
 * The plain text a paste is allowed to insert.
 *
 * A contenteditable has no maxLength, so the cap has to be enforced by hand, and paste is the
 * one path that can blow past it in a single gesture. The selection the paste replaces is room
 * the paste gets back. Returns "" when the field is already full, which means the paste is a no
 * op rather than a silent overflow.
 */
export function pasteInsertion(input: PasteInsertion): string {
  const cap = input.cap ?? DRAFT_MAX;
  const room = Math.max(0, cap - (input.draftLength - input.selectionLength));
  return clampToCap(toPlainDraft(input.pasted), room);
}

/**
 * The exact characters to drop at the caret.
 *
 * A newline at the very END of the field has no line after it for the caret to sit on, so the
 * browser puts the caret back in front of the newline and the next keystroke lands on the line
 * above: shift plus enter looked like it had done nothing. A second newline gives that line
 * somewhere to be. The extra one is trailing whitespace, so submittableText trims it off before
 * anything is sent, and the browser drops it again on the next keystroke.
 *
 * @param atEnd nothing follows the caret in the field.
 */
export function textToInsert(text: string, atEnd: boolean): string {
  return atEnd && text.endsWith("\n") ? `${text}\n` : text;
}
