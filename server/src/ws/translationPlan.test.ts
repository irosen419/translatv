// The single decision about what happens to one finalized line.
//
// Three outcomes, decided once and in one place: skip it (nothing was attempted and nothing went
// wrong), refuse it (something is wrong and the reader must be told), or translate it. They used
// to be two, and the missing one is why an unresolvable dialect was silently rendered as
// "you both speak the same language": translationNeed's predecessor resolved an unknown code to
// en-US on BOTH sides before comparing, so an unknown dialect against an English speaker came back
// "no translation needed" and the line went out untranslated with no marker and no reason.

import { describe, expect, it } from "vitest";

import type { Member } from "../rooms/RoomManager.js";
import { translationPlanFor } from "./server.js";

function member(over: Partial<Member> = {}): Member {
  return {
    id: "M2",
    username: "Ben",
    dialect: "es-AR",
    resumeTokenHash: "hash",
    connected: true,
    reconnectDeadline: null,
    polite: true,
    micEnabled: true,
    cameraEnabled: false,
    wantsTranslation: true,
    ...over,
  };
}

describe("translationPlanFor", () => {
  it("translates a genuine cross language line", () => {
    expect(translationPlanFor("en-US", "es-AR", member())).toEqual({ kind: "translate" });
  });

  it("skips a line nobody is there to read", () => {
    expect(translationPlanFor("en-US", "en-US", undefined)).toEqual({
      kind: "skip",
      reason: "no_peer",
    });
  });

  it("skips two dialects of one language", () => {
    expect(translationPlanFor("en-US", "en-GB", member({ dialect: "en-GB" }))).toEqual({
      kind: "skip",
      reason: "same_language",
    });
  });

  it("skips when the person who would read it turned translation off", () => {
    expect(translationPlanFor("en-US", "es-AR", member({ wantsTranslation: false }))).toEqual({
      kind: "skip",
      reason: "recipient_off",
    });
  });

  // The fix. An unresolvable dialect is not a skip and must never be reported as one: a skip says
  // nothing went wrong, and something did.
  it("REFUSES an unresolvable dialect rather than calling it the same language", () => {
    const plan = translationPlanFor("xx-YY", "en-GB", member({ dialect: "en-GB" }));
    expect(plan.kind).toBe("refuse");
    if (plan.kind !== "refuse") throw new Error("unreachable");
    expect(plan.reason).toBe("UNRESOLVED_DIALECT");
  });

  it("refuses whichever side is unresolvable", () => {
    expect(translationPlanFor("en-US", "xx-YY", member({ dialect: "xx-YY" })).kind).toBe("refuse");
    expect(translationPlanFor("xx-YY", "zz-ZZ", member({ dialect: "zz-ZZ" })).kind).toBe("refuse");
  });

  // Order matters, and it is a money order. Both of these save the call outright, so neither
  // should be overridden by a refusal that only tells someone about a call nobody was going to
  // make. An empty room and a reader who opted out are still a plain skip.
  it("keeps the free outcomes ahead of the refusal", () => {
    expect(translationPlanFor("xx-YY", "xx-YY", undefined)).toEqual({
      kind: "skip",
      reason: "no_peer",
    });
    expect(
      translationPlanFor("xx-YY", "es-AR", member({ wantsTranslation: false })),
    ).toEqual({ kind: "skip", reason: "recipient_off" });
  });
});
