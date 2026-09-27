import { describe, expect, it } from "vitest";
import { LIMITS, parseClientMessage } from "@translatv/shared";
import {
  DRAFT_MAX,
  clampToCap,
  draftLength,
  pasteInsertion,
  placeholderVisible,
  submittableText,
  textToInsert,
  toPlainDraft,
} from "./composer.js";

describe("placeholderVisible", () => {
  it("shows the placeholder when the field is empty and unfocused", () => {
    expect(placeholderVisible("", false)).toBe(true);
  });

  // The whole point of the custom placeholder: it leaves on FOCUS, not on the first keystroke,
  // which is what a native placeholder attribute would do.
  it("hides the placeholder the moment the empty field is focused", () => {
    expect(placeholderVisible("", true)).toBe(false);
  });

  it("hides the placeholder whenever there is a draft", () => {
    expect(placeholderVisible("hola", true)).toBe(false);
    expect(placeholderVisible("hola", false)).toBe(false);
  });

  // A lone space is a draft, not emptiness. Showing the placeholder under it would overlap the
  // caret with the prompt text.
  it("treats whitespace as a draft rather than as empty", () => {
    expect(placeholderVisible(" ", false)).toBe(false);
    expect(placeholderVisible("\n", false)).toBe(false);
  });
});

describe("submittableText", () => {
  it("returns the trimmed draft when there is something to send", () => {
    expect(submittableText("  hola  ")).toBe("hola");
  });

  it("refuses an empty draft", () => {
    expect(submittableText("")).toBe(null);
  });

  it("refuses a whitespace only draft, including newlines from shift plus enter", () => {
    expect(submittableText("   ")).toBe(null);
    expect(submittableText("\n\n")).toBe(null);
    expect(submittableText(" \n \t ")).toBe(null);
  });

  it("keeps interior newlines, since the field is multi line now", () => {
    expect(submittableText("  uno\ndos  ")).toBe("uno\ndos");
  });

  it("keeps Spanish diacritics and inverted punctuation intact", () => {
    expect(submittableText(" ¿Cómo estás, señor? ¡Vení mañana! ")).toBe(
      "¿Cómo estás, señor? ¡Vení mañana!",
    );
  });
});

describe("clampToCap", () => {
  it("leaves a draft under the cap alone", () => {
    expect(clampToCap("hola", 2000)).toBe("hola");
  });

  it("cuts a draft that runs past the cap", () => {
    expect(clampToCap("abcdef", 4)).toBe("abcd");
  });

  it("takes its cap from the wire contract rather than a number of its own", () => {
    // protocol.ts is the single source of truth for what the server will accept. A 2000 written
    // here as well is a second truth that can drift from it silently.
    expect(DRAFT_MAX).toBe(LIMITS.chat);
    expect(clampToCap("x".repeat(2500)).length).toBe(LIMITS.chat);
  });

  it("counts accented characters as one character each", () => {
    // Precomposed, so one UTF-16 unit each. This is the ordinary Spanish case and it must not
    // cost the writer anything.
    expect(clampToCap("áéíóú", 3)).toBe("áéí");
  });

  // The cut walks code points so it can never land inside a pair, but it MEASURES in UTF-16
  // units, because that is what the server counts. Measuring in code points let a draft of
  // astral characters pass here and be refused there.
  it("stops before a surrogate pair rather than splitting it or overshooting", () => {
    const clamped = clampToCap("ab\u{1F600}cd", 3);
    // The emoji needs two units and only one is left, so it does not go in. The old behavior
    // returned "ab\u{1F600}", which is four units against a cap of three.
    expect(clamped).toBe("ab");
    expect(clamped.includes("\uFFFD")).toBe(false);
  });

  it("admits a pair when there is exactly room for it", () => {
    expect(clampToCap("ab\u{1F600}cd", 4)).toBe("ab\u{1F600}");
  });

  // The bug this pins. 1200 emoji is 1200 code points and 2400 UTF-16 units. Counting points
  // let the client call that draft sendable, the Send button enable, the field clear on Enter,
  // and the server refuse the frame: the message vanished with nothing on screen to say so.
  it("clamps a draft of astral characters to something the server will actually accept", () => {
    const clamped = clampToCap("\u{1F600}".repeat(1200));
    expect(clamped.length).toBeLessThanOrEqual(LIMITS.chat);
    const parsed = parseClientMessage(JSON.stringify({ t: "chat.send", text: clamped }));
    expect(parsed.ok).toBe(true);
  });

  it("measures a draft the way the wire does", () => {
    expect(draftLength("\u{1F600}")).toBe(2);
    expect(draftLength("áé")).toBe(2);
  });
});

describe("toPlainDraft", () => {
  // The field is a contenteditable, so anything pasted into it is a direct injection surface.
  // Pasted content is read as plain text and normalized here before it is inserted as a text
  // node. Markup is never parsed, it stays literal characters.
  it("keeps markup as literal characters rather than as nodes", () => {
    expect(toPlainDraft("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
    expect(toPlainDraft("<script>alert(1)</script>")).toBe("<script>alert(1)</script>");
  });

  it("normalizes Windows and old Mac line endings to plain newlines", () => {
    expect(toPlainDraft("uno\r\ndos\rtres")).toBe("uno\ndos\ntres");
  });

  it("turns tabs into spaces, because a tab in a chat line is noise", () => {
    expect(toPlainDraft("uno\tdos")).toBe("uno dos");
  });

  it("drops control characters that would be invisible in the field", () => {
    expect(toPlainDraft("ho\u0000la\u0007")).toBe("hola");
  });

  it("leaves ordinary Spanish text untouched", () => {
    expect(toPlainDraft("¿Nos vemos mañana, señor?")).toBe("¿Nos vemos mañana, señor?");
  });
});

describe("pasteInsertion", () => {
  it("inserts the whole paste when it fits under the cap", () => {
    expect(pasteInsertion({ draftLength: 3, selectionLength: 0, pasted: "hola", cap: 10 })).toBe(
      "hola",
    );
  });

  // The cap has to survive paste, since a contenteditable has no maxLength attribute to lean on.
  it("trims the paste to whatever room is left", () => {
    expect(pasteInsertion({ draftLength: 8, selectionLength: 0, pasted: "hola", cap: 10 })).toBe(
      "ho",
    );
  });

  it("counts a replaced selection as room the paste gets back", () => {
    expect(pasteInsertion({ draftLength: 10, selectionLength: 4, pasted: "hola", cap: 10 })).toBe(
      "hola",
    );
  });

  it("inserts nothing when the field is already full", () => {
    expect(pasteInsertion({ draftLength: 10, selectionLength: 0, pasted: "hola", cap: 10 })).toBe(
      "",
    );
  });

  it("normalizes the paste before measuring it", () => {
    expect(pasteInsertion({ draftLength: 0, selectionLength: 0, pasted: "a\r\nb", cap: 10 })).toBe(
      "a\nb",
    );
  });

  it("defaults to the repo wide cap", () => {
    const pasted = "x".repeat(50);
    expect(pasteInsertion({ draftLength: DRAFT_MAX - 10, selectionLength: 0, pasted }).length).toBe(
      10,
    );
  });
});

describe("textToInsert", () => {
  it("inserts what it was given in the middle of a draft", () => {
    expect(textToInsert("\n", false)).toBe("\n");
    expect(textToInsert("hola", false)).toBe("hola");
  });

  // The bug this exists for: a newline at the very end of the field has no line after it for the
  // caret to sit on, so the browser drops the caret in FRONT of it and the next keystroke lands
  // on the line above. A second newline gives that line somewhere to be. The extra one is
  // trailing whitespace, so submittableText trims it off before anything is sent.
  it("pads a newline at the end of the draft so the caret has a line to land on", () => {
    expect(textToInsert("\n", true)).toBe("\n\n");
    expect(textToInsert("uno\n", true)).toBe("uno\n\n");
  });

  it("leaves a paste that does not end in a newline alone, even at the end", () => {
    expect(textToInsert("hola", true)).toBe("hola");
  });

  it("pads nothing when there is nothing to insert", () => {
    expect(textToInsert("", true)).toBe("");
  });
});
