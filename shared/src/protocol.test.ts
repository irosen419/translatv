// The schemas here are the server's input validation, not just types, so what they accept and
// reject is a security boundary rather than a convenience.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { DIALECT_CODES } from "./languages.js";
import {
  dialectCode,
  ERROR_CODES,
  errorCode,
  glossaryEntry,
  LIMITS,
  parseClientMessage,
  serverGlossaryEntry,
  serverMessage,
  TRANSLATION_FAILURE_CODES,
  translationFailureCode,
  username,
} from "./protocol.js";

/** parseClientMessage reports a verdict rather than throwing, so a bad frame is a close code. */
function accepts(message: unknown): boolean {
  return parseClientMessage(JSON.stringify(message)).ok;
}

describe("member.update", () => {
  it("accepts a media only update", () => {
    expect(accepts({ t: "member.update", micEnabled: false })).toBe(true);
    expect(accepts({ t: "member.update", cameraEnabled: false })).toBe(true);
  });

  it("accepts a translation preference update", () => {
    expect(accepts({ t: "member.update", wantsTranslation: false })).toBe(true);
  });

  it("accepts every field at once", () => {
    expect(
      accepts({
        t: "member.update",
        username: "Ana",
        dialect: "es-AR",
        micEnabled: true,
        cameraEnabled: false,
        wantsTranslation: false,
      }),
    ).toBe(true);
  });

  it("rejects a non boolean flag", () => {
    expect(accepts({ t: "member.update", micEnabled: "no" })).toBe(false);
    expect(accepts({ t: "member.update", wantsTranslation: 1 })).toBe(false);
  });

  // The existing shapes have to keep working: this message predates the new fields and the
  // dialect picker still sends the dialect only form.
  it("still accepts the username only and dialect only forms", () => {
    expect(accepts({ t: "member.update", username: "Ana" })).toBe(true);
    expect(accepts({ t: "member.update", dialect: "es-AR" })).toBe(true);
    expect(accepts({ t: "member.update" })).toBe(true);
  });

  it("still rejects an unknown dialect", () => {
    expect(accepts({ t: "member.update", dialect: "xx-YY" })).toBe(false);
  });
});

// The server sends CODES for anything a user reads, never prose. The client owns every word on
// screen, so it can render them in the reader's own language. These schemas are what keeps the
// two lists from drifting: a code the server invents and the client has no copy for is a blank
// space where an explanation should be.
describe("user facing codes", () => {
  it("accepts every error code it publishes", () => {
    for (const code of ERROR_CODES) {
      expect(errorCode.safeParse(code).success).toBe(true);
    }
  });

  it("refuses prose where an error code belongs", () => {
    expect(errorCode.safeParse("that chat already has two people in it").success).toBe(false);
  });

  it("accepts every translation failure code it publishes", () => {
    for (const code of TRANSLATION_FAILURE_CODES) {
      expect(translationFailureCode.safeParse(code).success).toBe(true);
    }
  });

  it("refuses prose where a translation failure code belongs", () => {
    expect(translationFailureCode.safeParse("translating too fast, catching up").success).toBe(
      false,
    );
  });

  it("keeps the exported arrays and the schemas as one list", () => {
    expect([...errorCode.options]).toEqual([...ERROR_CODES]);
    expect([...translationFailureCode.options]).toEqual([...TRANSLATION_FAILURE_CODES]);
  });
});

// Dialects travel as an enum in the exported schema (so the Swift side can decode them into one),
// and the switch from a refine to an enum must not change what the server accepts or what it says
// when it refuses.
describe("dialectCode", () => {
  it("accepts every published dialect and nothing else, with the same message as before", () => {
    for (const code of DIALECT_CODES) expect(dialectCode.safeParse(code).success).toBe(true);
    for (const bad of ["xx-YY", "es", "ES-AR", "", " es-AR"]) {
      const parsed = dialectCode.safeParse(bad);
      expect(parsed.success, bad).toBe(false);
      expect(parsed.success ? "" : parsed.error.issues[0]?.message).toBe("unknown dialect");
    }
  });

  it("keeps zod's own message for a missing or non string value", () => {
    // The errorMap renames only the enum refusal. A missing or non string dialect still says what
    // it always said, since MALFORMED's detail is for whoever is debugging the client.
    const missing = dialectCode.safeParse(undefined);
    expect(missing.success ? "" : missing.error.issues[0]?.message).toBe("Required");
    const number = dialectCode.safeParse(5);
    expect(number.success ? "" : number.error.issues[0]?.message).toMatch(/received number/);
  });

  it("is an enum, so the exported schema can list the codes", () => {
    expect(dialectCode).toBeInstanceOf(z.ZodEnum);
    expect([...(dialectCode as z.ZodEnum<[string, ...string[]]>).options]).toEqual([...DIALECT_CODES]);
  });
});

// The text limits moved from a refine to a pipe, so the generator can see them. What the server
// accepts must not move with them: the limit still applies to the CLEANED value, in UTF-16 units.
describe("text limits", () => {
  const stt = (text: string) => accepts({ t: "stt.final", text, seq: 1 });

  it("measures the cleaned text, so surrounding whitespace past the limit is still accepted", () => {
    expect(stt("a".repeat(LIMITS.transcript))).toBe(true);
    expect(stt(`  ${"a".repeat(LIMITS.transcript)}  \n`)).toBe(true);
    expect(stt("a".repeat(LIMITS.transcript + 1))).toBe(false);
  });

  it("counts UTF-16 units, so an astral character counts twice", () => {
    expect(stt("😀".repeat(LIMITS.transcript / 2))).toBe(true);
    expect(stt("😀".repeat(LIMITS.transcript / 2) + "a")).toBe(false);
  });

  it("keeps each refusal's message", () => {
    const long = parseClientMessage(JSON.stringify({ t: "chat.send", text: "a".repeat(LIMITS.chat + 1) }));
    expect(long.ok ? "" : long.reason).toBe(`text must be at most ${LIMITS.chat} characters`);
    const name = parseClientMessage(
      JSON.stringify({ t: "room.join", code: "7KQ2M9XA", username: " ​ ", dialect: "es-AR" }),
    );
    expect(name.ok ? "" : name.reason).toBe(`username must be 1 to ${LIMITS.username} characters`);
  });

  it("turns every line break into a space, CRLF into two, as the exported description says", () => {
    // \r and \n are both control characters, so the control character replace takes them before
    // the CRLF replace after it can match. That is the behavior on main; this pins the published
    // description of it ("line breaks included, replaced by spaces").
    const clean = (text: string) => {
      const parsed = parseClientMessage(JSON.stringify({ t: "chat.send", text }));
      return parsed.ok && parsed.message.t === "chat.send" ? parsed.message.text : null;
    };
    expect(clean("a\r\nb\nc\td")).toBe("a  b c d");
    // So a client counting CRLF as one unit is refused for text it thought was in bounds.
    expect(clean("a\r\n".repeat(999) + "a")).toBeNull();
  });

  it("cleans a username before measuring it", () => {
    expect(username.safeParse(`  ${"a".repeat(LIMITS.username)}​ `).success).toBe(true);
    expect(username.safeParse("a".repeat(LIMITS.username + 1)).success).toBe(false);
    expect(username.parse("  Ana ‮ ")).toBe("Ana");
  });

  it("keeps the glossary limits on what a client sends", () => {
    const entry = { source: "a", target: "b", sourceDialect: "es-AR", targetDialect: "en-US" };
    expect(glossaryEntry.safeParse({ ...entry, source: "a".repeat(LIMITS.glossaryTerm) }).success).toBe(true);
    expect(glossaryEntry.safeParse({ ...entry, source: "a".repeat(LIMITS.glossaryTerm + 1) }).success).toBe(false);
    expect(glossaryEntry.safeParse({ ...entry, target: "a".repeat(LIMITS.glossaryTranslation + 1) }).success).toBe(
      false,
    );
  });
});

// The shared snag (docs/HANDOFF-NEXT-PRS.md): RoomSession.correct makes a glossary entry whose
// source is the corrected line's whole text, up to LIMITS.transcript, so what the SERVER sends is
// published separately from what a client may send, and publishes what is really sent.
describe("serverGlossaryEntry", () => {
  const entry = { source: "a", target: "b", sourceDialect: "es-AR", targetDialect: "en-US" };

  it("takes a source as long as a whole line, and no longer", () => {
    expect(serverGlossaryEntry.safeParse({ ...entry, source: "a".repeat(LIMITS.transcript) }).success).toBe(true);
    expect(serverGlossaryEntry.safeParse({ ...entry, source: "a".repeat(LIMITS.transcript + 1) }).success).toBe(false);
  });

  it("keeps the translation limit and the dialect enum", () => {
    expect(serverGlossaryEntry.safeParse({ ...entry, target: "a".repeat(LIMITS.glossaryTranslation + 1) }).success).toBe(
      false,
    );
    expect(serverGlossaryEntry.safeParse({ ...entry, targetDialect: "xx-YY" }).success).toBe(false);
  });

  it("is what glossary.updated and the room.joined snapshot carry", () => {
    const long = { ...entry, source: "a".repeat(LIMITS.glossaryTerm + 1) };
    expect(serverMessage.safeParse({ t: "glossary.updated", entries: [long] }).success).toBe(true);
    const joined = serverMessage.options.find((o) => o.shape.t.value === "room.joined");
    const snapshot = (joined?.shape as { snapshot: z.AnyZodObject }).snapshot;
    expect(snapshot.safeParse({ lines: [], glossary: [long] }).success).toBe(true);
  });
});

// The four dialect fields the server sends were plain strings even in zod, so the export said
// nothing about them. They are dialectCode now.
describe("server sent dialects", () => {
  const member = {
    id: "m",
    username: "Ana",
    dialect: "es-AR",
    connection: "connected",
    micEnabled: true,
    cameraEnabled: true,
    wantsTranslation: true,
    isHost: true,
  };
  const line = {
    lineId: "L1",
    from: "m",
    srcDialect: "es-AR",
    text: "hola",
    source: "speech",
    ts: "2026-10-09T00:00:00.000Z",
    translated: null,
    translationStatus: "pending",
    revision: 0,
    skipReason: null,
  };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["member.dialect", { t: "peer.joined", peer: member }, "peer.dialect"],
    ["srcDialect", { t: "transcript.final", line }, "line.srcDialect"],
    ["peer.updated dialect", { t: "peer.updated", peerId: "m", dialect: "es-AR" }, "dialect"],
    [
      "translation.result targetDialect",
      { t: "translation.result", lineId: "L1", targetDialect: "en-US", text: "hi", revision: 1, origin: "model" },
      "targetDialect",
    ],
  ];

  it.each(cases)("%s accepts a code and refuses anything else", (_name, frame, path) => {
    expect(serverMessage.safeParse(frame).success).toBe(true);
    const bad = structuredClone(frame);
    const keys = path.split(".");
    let at: Record<string, unknown> = bad;
    for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>;
    at[keys[keys.length - 1] as string] = "xx-YY";
    expect(serverMessage.safeParse(bad).success).toBe(false);
  });
});
