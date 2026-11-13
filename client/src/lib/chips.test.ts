import { describe, expect, it } from "vitest";
import { buildChips, isProblem, sttAlert, type ChipState } from "./chips.js";
import { useStore } from "../state/store.js";

// The chips are asserted by KEY, not by words. Which chip exists is what this module decides;
// what it says in Spanish is copy.test.ts's problem, and asserting English here would have made
// every translated string a test failure.

/** A room where nothing is wrong: peer present, everything connected, cloud speech running. */
function quiet(over: Partial<ChipState> = {}): ChipState {
  return {
    peerPresent: true,
    peerConnection: "connected",
    peerState: "connected",
    socketState: "open",
    sttStatus: { kind: "listening", onDevice: false },
    peerName: "Ben",
    peerMicEnabled: true,
    peerWantsTranslation: true,
    translationUnavailable: null,
    onToggleSttEngine: () => {},
    ...over,
  } as ChipState;
}

const problems = (state: ChipState) => buildChips(state).filter(isProblem).map((c) => c.text);
const rest = (state: ChipState) => buildChips(state).filter((c) => !isProblem(c)).map((c) => c.text);

describe("buildChips", () => {
  it("reports no problems when nothing is wrong", () => {
    expect(problems(quiet())).toEqual([]);
  });

  it("treats the engine chip as information, not a problem", () => {
    // It is a CONTROL: which engine is running is the biggest lever on subtitle quality. Floating
    // it over the video as though something were broken would cry wolf on every single call.
    expect(rest(quiet())).toContain("chips.cloud");
    expect(rest(quiet({ sttStatus: { kind: "listening", onDevice: true } }))).toContain("chips.onDevice");
    expect(problems(quiet({ sttStatus: { kind: "listening", onDevice: true } }))).toEqual([]);
  });

  it("surfaces a muted peer as a problem", () => {
    expect(problems(quiet({ peerMicEnabled: false }))).toContain("chips.muted");
  });

  it("surfaces a dropped socket as a problem", () => {
    expect(problems(quiet({ socketState: "reconnecting" }))).toContain("chips.reconnecting");
  });

  it("surfaces failed speech recognition as a problem", () => {
    const state = quiet({ sttStatus: { kind: "failed", notice: { key: "stt.wontStart" } } });
    expect(problems(state)).toContain("chips.noSubtitles");
  });

  it("surfaces a failed media connection as a problem", () => {
    expect(problems(quiet({ peerState: "failed" }))).toContain("chips.noMedia");
  });

  it("says nothing about a peer who is not there yet", () => {
    // Every peer scoped chip is gated on peerPresent. Alone in a room the other person is not
    // muted, they are absent, and reporting the two the same way would be a lie.
    expect(buildChips(quiet({ peerPresent: false, peerMicEnabled: false })).map((c) => c.text)).not.toContain(
      "chips.muted",
    );
  });

  it("says nothing about translation while translation is working", () => {
    expect(buildChips(quiet()).map((c) => c.text)).not.toContain("translation unavailable");
  });
});

// The wiring test for the latch that used to be invisible.
//
// It deliberately runs the REAL store rather than a hand built ChipState, because the defect was
// never in either half on its own: the store recorded the failure correctly and nothing on screen
// ever read what it recorded. Two isolated unit tests would both have passed against the bug.
describe("a terminal translation failure", () => {
  it("reaches the screen as a visible problem chip, carrying the reason", () => {
    useStore.getState().reset();
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "unavailable",
      retriable: false,
      reason: "NOT_CONFIGURED",
    });

    const chips = buildChips(
      quiet({ translationUnavailable: useStore.getState().translationUnavailable }),
    );
    const chip = chips.find((c) => c.text === "chips.translationUnavailable");

    expect(chip).toBeDefined();
    // A chip nobody can see on a phone is the bug again in a different place: only problem chips
    // float over the video, everything else rides down into a drawer behind a gear.
    expect(isProblem(chip!)).toBe(true);
    // The title is KEYS now, so this asserts the chip names the right failure rather than
    // asserting an English sentence a Spanish reader would never see.
    expect(chip!.title).toEqual([
      { key: "failure.NOT_CONFIGURED" },
      { key: "chips.translationUnavailable.stillWorks" },
    ]);
  });

  it("stays quiet for a retriable failure, which is not the session going down", () => {
    useStore.getState().reset();
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "rate_limited",
      retriable: true,
      reason: "TOO_FAST",
    });

    expect(useStore.getState().translationUnavailable).toBeNull();
  });
});

/**
 * The alert is a separate decision from the chip, and deliberately so.
 *
 * A chip is two words in a strip. That is right for "they are muted", which is someone else's
 * doing and nothing you can act on, and it was wrong for this: a real call ran with the speaker
 * believing they were being subtitled, because "no subtitles" in a pill said nothing about the
 * consequence and the explanation was in a `title` tooltip, which does not exist on a phone.
 *
 * So the same state now produces both. The chip stays, because the strip should still show it.
 * The alert is the sentence, and it says what the OTHER person is missing, which is the part
 * nobody can work out for themselves.
 */
describe("sttAlert", () => {
  it("says nothing while speech is working", () => {
    expect(sttAlert(quiet())).toBeNull();
    expect(sttAlert(quiet({ sttStatus: { kind: "listening", onDevice: true } }))).toBeNull();
    expect(sttAlert(quiet({ kind: "idle" } as never))).toBeNull();
  });

  it("stays quiet while a reconnect is still in flight", () => {
    // Transient. The supervisor is backing off and will retry, and a banner that appears on
    // every wobble is one people learn to close without reading.
    expect(sttAlert(quiet({ sttStatus: { kind: "reconnecting", attempt: 2 } }))).toBeNull();
    expect(sttAlert(quiet({ sttStatus: { kind: "downloading", language: "en-US" } }))).toBeNull();
  });

  for (const status of [
    { kind: "blocked", reason: "permission", notice: { key: "stt.permission" } },
    { kind: "blocked", reason: "no-microphone", notice: { key: "stt.noMicrophone" } },
    { kind: "failed", notice: { key: "stt.keepsDropping" } },
  ] as const) {
    it(`speaks up when speech is ${status.kind} (${"reason" in status ? status.reason : "terminal"})`, () => {
      const alert = sttAlert(quiet({ sttStatus: status }));
      expect(alert).not.toBeNull();
      // The headline names YOUR device, and the body names what your partner loses. Both, and
      // in that order: the first tells you it is yours to fix, the second is why you should.
      expect(alert?.title).toBe("alert.noSubtitles.title");
      expect(alert?.body).toBe("alert.noSubtitles.body");
    });
  }

  it("carries the adapter's own instructions through rather than restating them", () => {
    // The adapter already worked out WHAT went wrong and handed back a ref. Rewriting that here
    // would mean this module owning a second, drifting copy of every device specific fix.
    const notice = { key: "stt.permission" } as const;
    expect(sttAlert(quiet({ sttStatus: { kind: "blocked", reason: "permission", notice } }))?.notice).toBe(
      notice,
    );
  });

  it("keeps the chip as well, so the strip still reports it", () => {
    const blocked = quiet({
      sttStatus: { kind: "blocked", reason: "permission", notice: { key: "stt.permission" } },
    });
    expect(problems(blocked)).toContain("chips.noSubtitles");
    expect(sttAlert(blocked)).not.toBeNull();
  });
});

describe("the wrong language warning", () => {
  it("is a problem, so it floats over the video on a phone", () => {
    expect(problems(quiet({ speakingOtherLanguage: true }))).toContain("chips.wrongLanguage");
  });

  it("is absent when your lines are translating normally", () => {
    expect(buildChips(quiet()).map((c) => c.text)).not.toContain("chips.wrongLanguage");
  });
});
