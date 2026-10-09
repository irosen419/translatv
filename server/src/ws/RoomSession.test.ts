// The room's memory of corrections, before a call closes and hands them to their author's account.

import { describe, expect, it } from "vitest";

import { LIMITS } from "@translatv/shared";
import { RoomSession } from "./RoomSession.js";

function sessionWithLine(text = "we moved the standup to Friday") {
  const session = new RoomSession();
  const line = session.addLine({ from: "ana", username: "Ana", srcDialect: "en-US", text, source: "speech" });
  return { session, line };
}

describe("RoomSession corrections", () => {
  it("hands each member their own corrections, oldest first, once", () => {
    const { session, line } = sessionWithLine();
    session.correct({ lineId: line.lineId, phrase: "the standup", fix: "la daily", targetDialect: "es-AR", authorMemberId: "ben" });
    session.correct({ lineId: line.lineId, phrase: "Friday", fix: "viernes", targetDialect: "es-AR", authorMemberId: "ben" });
    expect(session.takeCorrections("ben").map((e) => e.source)).toEqual(["the standup", "Friday"]);
    expect(session.takeCorrections("ben")).toEqual([]);
    expect(session.takeCorrections("ana")).toEqual([]);
  });

  // Review round 1: the list grew with every correction a client sent, unbounded, until the call
  // closed. It is memory a client controls, so it is capped like the glossary it feeds.
  it("keeps at most the glossary's limit per member, the newest", () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const { session, line } = sessionWithLine(words.join(" "));
    for (const word of words) {
      session.correct({ lineId: line.lineId, phrase: word, fix: `${word}!`, targetDialect: "es-AR", authorMemberId: "ben" });
    }
    const taken = session.takeCorrections("ben");
    expect(taken).toHaveLength(LIMITS.glossaryEntries);
    expect(taken[taken.length - 1]?.source).toBe("w99");
    expect(taken[0]?.source).toBe(`w${100 - LIMITS.glossaryEntries}`);
  });

  it("keeps one correction per phrase, the latest, so repeats cannot push others out", () => {
    const { session, line } = sessionWithLine("che boludo vení");
    session.correct({ lineId: line.lineId, phrase: "vení", fix: "come", targetDialect: "en-US", authorMemberId: "ben" });
    for (let i = 0; i < 60; i += 1) {
      session.correct({ lineId: line.lineId, phrase: "che", fix: `hey ${i}`, targetDialect: "en-US", authorMemberId: "ben" });
    }
    expect(session.takeCorrections("ben").map((e) => `${e.source}=${e.target}`)).toEqual(["vení=come", "che=hey 59"]);
  });

  it("collapses the phrase's whitespace before it reaches the room glossary", () => {
    const { session, line } = sessionWithLine();
    session.correct({ lineId: line.lineId, phrase: "the   standup", fix: "la daily", targetDialect: "es-AR", authorMemberId: "ben" });
    expect(session.glossaryEntries[0]?.source).toBe("the standup");
  });
});
