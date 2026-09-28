import { afterEach, describe, expect, it, vi } from "vitest";
import { log, scrub } from "./log.js";

// The test CLAUDE.md and log.ts both said existed. It did not, and this file is the whole reason
// either claim is true. The privacy promise of this app is that nothing is stored; a log line
// carrying a transcript breaks that promise quietly, in a file nobody reads until they do.

describe("scrub", () => {
  it("withholds a text field, which is the specific promise in CLAUDE.md", () => {
    expect(scrub({ event: "x", text: "hola que tal" })).toEqual({
      event: "x",
      text: "[withheld 12 chars]",
    });
  });

  it("withholds every key that can carry what a person said", () => {
    const carriers = [
      "text",
      "original",
      "translated",
      "transcript",
      "username",
      "correctedTranslation",
      "glossary",
      "entries",
      "sdp",
      "candidate",
      "note",
      "resumeToken",
    ];
    for (const key of carriers) {
      const scrubbed = scrub({ [key]: "secret words" }) as Record<string, unknown>;
      expect(scrubbed[key], `${key} reached the log intact`).toBe("[withheld 12 chars]");
    }
  });

  // Accounts arrived in M3, and with them a second kind of thing that must never reach a log:
  // credentials and the address that identifies a person. An email in a log file outlives the
  // account it belonged to, and a token in one is a session for whoever reads it.
  it("withholds an email address", () => {
    const scrubbed = scrub({ event: "auth.login", email: "ana@example.test" }) as Record<string, unknown>;
    expect(scrubbed["email"]).toBe("[withheld 16 chars]");
    expect(JSON.stringify(scrubbed)).not.toContain("ana@example.test");
  });

  it("withholds every key that can carry a credential or identify an account holder", () => {
    for (const key of [
      "email",
      "password",
      "accessToken",
      "refreshToken",
      "token",
      "invite",
      "displayName",
      "authorization",
    ]) {
      const scrubbed = scrub({ nested: { [key]: "secret words" } }) as { nested: Record<string, unknown> };
      expect(scrubbed.nested[key], `${key} reached the log intact`).toBe("[withheld 12 chars]");
    }
  });

  it("records the length rather than deleting the key", () => {
    // log.ts's stated reason, and it is the difference between two facts a reader needs to tell
    // apart: an event that HAD no text, and an event whose text was withheld.
    const scrubbed = scrub({ text: "hola" }) as Record<string, unknown>;
    expect(Object.keys(scrubbed)).toContain("text");
    expect(scrubbed.text).toBe("[withheld 4 chars]");
  });

  it("marks a non string carrier as withheld without claiming a length", () => {
    expect(scrub({ glossary: [{ source: "a", target: "b" }] })).toEqual({
      glossary: "[withheld]",
    });
  });

  it("reaches content nested inside objects", () => {
    expect(scrub({ room: "abc", line: { id: 7, text: "no puedo" } })).toEqual({
      room: "abc",
      line: { id: 7, text: "[withheld 8 chars]" },
    });
  });

  it("reaches content inside arrays", () => {
    // The shape a transcript snapshot actually has, so a lazy `log.info("resume", { snapshot })`
    // cannot leak the conversation one element at a time.
    expect(scrub({ lines: [{ text: "uno" }, { text: "dos" }] })).toEqual({
      lines: [{ text: "[withheld 3 chars]" }, { text: "[withheld 3 chars]" }],
    });
  });

  it("keeps the identifiers, counts, and durations it exists to carry", () => {
    const fields = { room: "A1B2C3D4", memberId: "m1", ms: 42, ok: true, count: 3 };
    expect(scrub(fields)).toEqual(fields);
  });

  it("stops descending at the depth limit rather than recursing without bound", () => {
    // Deeply nested input is hostile input. Returning the subtree untouched past the limit is the
    // existing behaviour; asserting it means a change to that tradeoff has to be deliberate.
    let deep: Record<string, unknown> = { text: "bottom" };
    for (let i = 0; i < 9; i += 1) deep = { nested: deep };
    expect(() => scrub(deep)).not.toThrow();
  });

  it("passes primitives and null straight through", () => {
    expect(scrub(null)).toBe(null);
    expect(scrub(7)).toBe(7);
    expect(scrub("plain")).toBe("plain");
  });
});

/**
 * Every line the logger writes, whichever console method it writes with. A test watching some of
 * them passed with nothing to read once the logger moved to another: warnings to console.error,
 * and info to console.info, where a leak on an info line then went unseen (both measured in
 * review). Required to hold what the test looks for, so it cannot pass empty.
 */
function written(): () => string[] {
  const spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
  return () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0])));
}

describe("the emitted line", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never contains the raw content, at any level", () => {
    const lines = written();
    log.info("transcript.final", {
      room: "A1B2C3D4",
      line: { id: "l1", text: "esto es privado" },
    });
    expect(lines()).toHaveLength(1);
    const [line] = lines() as [string];
    expect(line).not.toContain("esto es privado");
    expect(line).toContain("A1B2C3D4");
    expect(JSON.parse(line).event).toBe("transcript.final");
  });

  it("scrubs warnings and errors too, not only info", () => {
    const lines = written();
    log.warn("stt.retry", { text: "leaked?" });
    log.error("translate.failed", { original: "leaked?" });
    expect(lines().map((line) => JSON.parse(line).event).sort()).toEqual(["stt.retry", "translate.failed"]);
    expect(lines().join("\n")).not.toContain("leaked?");
  });
});
