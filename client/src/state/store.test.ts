// Reducer tests for the parts of the store that decide what the screen says about the OTHER
// person and about lines nobody translated.
//
// Note for anyone adding cases: reset() deliberately does not clear the media flags, so set what
// you need explicitly rather than relying on it. It DOES clear translationUnavailable, which is a
// claim about a server rather than a setting of yours.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Member, RenderedLine } from "@translatv/shared";
import { FALLBACK_DIALECT } from "@translatv/shared";

import { initialUiDialect, useStore } from "./store.js";

const PEER: Member = {
  id: "M2",
  username: "Ben",
  dialect: "es-AR",
  connection: "connected",
  // A guest. Admin is the server's answer about what was proved, so the ordinary peer is not one.
  isHost: false,
  micEnabled: true,
  cameraEnabled: true,
  wantsTranslation: true,
};

function line(overrides: Partial<RenderedLine> = {}): RenderedLine {
  return {
    lineId: "L1",
    from: "M1",
    srcDialect: "en-US",
    text: "do you have time tomorrow",
    source: "speech",
    ts: "2026-07-31T00:00:00.000Z",
    translated: null,
    translationStatus: "pending",
    revision: 0,
    skipReason: null,
    ...overrides,
  };
}

beforeEach(() => {
  useStore.getState().reset();
  useStore.setState({ peer: null, lines: [] });
});

describe("peer.updated", () => {
  it("patches only the field that was sent", () => {
    useStore.setState({ peer: PEER });
    useStore.getState().apply({ t: "peer.updated", peerId: "M2", micEnabled: false });

    const { peer } = useStore.getState();
    expect(peer?.micEnabled).toBe(false);
    expect(peer?.username).toBe("Ben");
    expect(peer?.dialect).toBe("es-AR");
    expect(peer?.cameraEnabled).toBe(true);
    expect(peer?.wantsTranslation).toBe(true);
  });

  it("carries the translation preference, which is what the chip reads", () => {
    useStore.setState({ peer: PEER });
    useStore.getState().apply({ t: "peer.updated", peerId: "M2", wantsTranslation: false });
    expect(useStore.getState().peer?.wantsTranslation).toBe(false);
  });

  it("ignores an update for somebody else", () => {
    useStore.setState({ peer: PEER });
    useStore.getState().apply({ t: "peer.updated", peerId: "SOMEONE_ELSE", micEnabled: false });
    expect(useStore.getState().peer?.micEnabled).toBe(true);
  });
});

describe("translation.skipped", () => {
  it("marks the line and leaves translated null", () => {
    useStore.setState({ lines: [line()] });
    useStore.getState().apply({
      t: "translation.skipped",
      lineId: "L1",
      reason: "same_language",
      revision: 1,
    });

    const [stored] = useStore.getState().lines;
    expect(stored?.translationStatus).toBe("skipped");
    // Null rather than a copy of the original: that copy is what the FAILURE path writes, and a
    // skip must stay distinguishable from a failure everywhere downstream.
    expect(stored?.translated).toBeNull();
  });

  it("records the reason, which used to be dropped on the floor", () => {
    // The retry path carries a reason on the wire and this handler never read it, so a line that
    // came back skipped after a retry lost the one fact that explains it.
    useStore.setState({ lines: [line()] });
    useStore.getState().apply({
      t: "translation.skipped",
      lineId: "L1",
      reason: "recipient_off",
      revision: 1,
    });
    expect(useStore.getState().lines[0]?.skipReason).toBe("recipient_off");
  });

  it("clears the reason once the line is translated after all", () => {
    // A retry that succeeds. Leaving the old reason behind would render a note explaining why a
    // line was not translated, underneath its translation.
    useStore.setState({
      lines: [line({ translationStatus: "skipped", skipReason: "recipient_off" })],
    });
    useStore.getState().apply({
      t: "translation.result",
      lineId: "L1",
      targetDialect: "es-AR",
      text: "tenes tiempo manana",
      revision: 1,
      origin: "model",
    });
    expect(useStore.getState().lines[0]?.skipReason).toBeNull();
  });

  it("clears the reason on a failure, which is not a skip", () => {
    useStore.setState({
      lines: [line({ translationStatus: "skipped", skipReason: "no_peer" })],
    });
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "rate_limited",
      retriable: true,
      reason: "TOO_FAST",
    });
    expect(useStore.getState().lines[0]?.skipReason).toBeNull();
  });

  it("does not clobber a correction that landed first", () => {
    useStore.setState({
      lines: [line({ translated: "corrected text", translationStatus: "ok", revision: 5 })],
    });
    useStore.getState().apply({
      t: "translation.skipped",
      lineId: "L1",
      reason: "recipient_off",
      revision: 2,
    });

    const [stored] = useStore.getState().lines;
    expect(stored?.translationStatus).toBe("ok");
    expect(stored?.translated).toBe("corrected text");
  });
});

describe("transcript.final", () => {
  it("stores a line that arrives already skipped, with no second message needed", () => {
    useStore.getState().apply({ t: "transcript.final", line: line({ translationStatus: "skipped" }) });
    expect(useStore.getState().lines[0]?.translationStatus).toBe("skipped");
  });

  it("still drops a duplicate from a resume snapshot", () => {
    useStore.getState().apply({ t: "transcript.final", line: line() });
    useStore.getState().apply({ t: "transcript.final", line: line() });
    expect(useStore.getState().lines).toHaveLength(1);
  });
});

// The session level "translation is not going to work" state.
//
// A REASON rather than a boolean, and read by buildChips rather than by nothing at all. The
// boolean this replaced was written on exactly this message and never read anywhere, so a server
// with no API key silently stopped translating for the whole call with nothing on screen.
describe("translationUnavailable", () => {
  it("records the reason only for a non retriable unavailable", () => {
    useStore.setState({ lines: [line()], translationUnavailable: null });
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "rate_limited",
      retriable: true,
      reason: "TOO_FAST",
    });
    expect(useStore.getState().translationUnavailable).toBeNull();

    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "unavailable",
      retriable: false,
      reason: "NOT_CONFIGURED",
    });
    // The CODE, kept as sent. It is the only thing that can tell the user which of the terminal
    // causes this was, and collapsing it to a boolean would throw that away. The words it turns
    // into are the reader's own, chosen from the copy files at paint time.
    expect(useStore.getState().translationUnavailable).toBe("NOT_CONFIGURED");
  });

  it("keeps the reason for a retriable unavailable out of the session state", () => {
    // A timeout and an empty model reply both surface as "unavailable" with retriable true. One
    // slow sentence must not tell the user translation is down for the call.
    useStore.setState({ lines: [line()], translationUnavailable: null });
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "unavailable",
      retriable: true,
      reason: "TIMED_OUT",
    });
    expect(useStore.getState().translationUnavailable).toBeNull();
  });

  it("is not tripped by a skip, which is not a failure", () => {
    useStore.setState({ lines: [line()], translationUnavailable: null });
    useStore.getState().apply({
      t: "translation.skipped",
      lineId: "L1",
      reason: "same_language",
      revision: 1,
    });
    expect(useStore.getState().translationUnavailable).toBeNull();
  });

  it("clears once a model actually translates something", () => {
    // Proof beats memory. Someone whose dialect could not be resolved fixes it mid call, or an
    // operator restarts a server with a good key: a latch that never cleared would keep claiming
    // translation is down while translated lines land on screen underneath it.
    useStore.setState({ lines: [line()], translationUnavailable: "NOT_CONFIGURED" });
    useStore.getState().apply({
      t: "translation.result",
      lineId: "L1",
      targetDialect: "es-AR",
      text: "tenes tiempo manana",
      revision: 1,
      origin: "model",
    });
    expect(useStore.getState().translationUnavailable).toBeNull();
  });

  it("is not cleared by an echo or a correction, neither of which proves anything", () => {
    useStore.setState({ lines: [line()], translationUnavailable: "NOT_CONFIGURED" });
    useStore.getState().apply({
      t: "translation.result",
      lineId: "L1",
      targetDialect: "en-GB",
      text: "do you have time tomorrow",
      revision: 1,
      origin: "echo",
    });
    expect(useStore.getState().translationUnavailable).toBe("NOT_CONFIGURED");

    useStore.getState().apply({
      t: "translation.result",
      lineId: "L1",
      targetDialect: "en-GB",
      text: "corrected by hand",
      revision: 2,
      origin: "correction",
    });
    expect(useStore.getState().translationUnavailable).toBe("NOT_CONFIGURED");
  });

  it("does not survive into the next room", () => {
    // Unlike the media flags, this is a claim about a server that the next room may not share.
    // Carrying it across would show "translation unavailable" in a room where it works fine, and
    // a fresh terminal failure re-latches it on the first line anyway.
    useStore.setState({ translationUnavailable: "NOT_CONFIGURED" });
    useStore.getState().reset();
    expect(useStore.getState().translationUnavailable).toBeNull();
  });
});

// The interface language, and the refusals that have to be readable in it.
//
// The store used to hold SENTENCES: the server's English prose for an error, and an English
// template for who ended the room. Both went straight onto the screen of whoever was in the
// call, whatever language they had picked. It holds decisions now, and these cases are what
// stops that regressing.
describe("the interface language", () => {
  it("starts from the browser's own language rather than defaulting to English", () => {
    // There is no jsdom here: this suite runs in the node environment. On the Node CI pins
    // there is no navigator at all and this lands on the fallback; on a newer Node it goes
    // through that runtime's own navigator. Both roads end at en-US, so what this pins is the
    // mechanism rather than a particular guess: the opening dialect is a real catalog code.
    // initialUiDialect's own cases cover the branches, this covers the wiring.
    expect(useStore.getState().uiDialect).toBe("en-US");
  });

  it("follows the server's copy of your dialect when you enter a room", () => {
    useStore.getState().setUiDialect("en-US");
    useStore.getState().apply({
      t: "room.created",
      code: "ABCD1234",
      selfId: "M1",
      resumeToken: "t",
      you: { ...PEER, id: "M1", username: "Ana", dialect: "es-CO" },
      polite: false,
      config: { graceMs: 1, maxMembers: 2 },
      iceServers: [],
    });
    expect(useStore.getState().uiDialect).toBe("es-CO");
  });

  it("survives going back to the start, because the reader did not change language", () => {
    useStore.getState().setUiDialect("es-AR");
    useStore.getState().reset();
    expect(useStore.getState().uiDialect).toBe("es-AR");
  });
});

describe("refusals", () => {
  it("stores an error as a code, not as the server's English", () => {
    useStore.getState().apply({ t: "error", code: "ROOM_FULL", fatal: true });
    expect(useStore.getState().error).toEqual({ key: "error.ROOM_FULL" });
  });

  it("carries the reason with someone thrown out of a room they were in", () => {
    useStore.setState({ phase: "room" });
    useStore.getState().apply({ t: "error", code: "ROOM_ENDED", fatal: true });
    expect(useStore.getState().phase).toBe("ended");
    expect(useStore.getState().ended?.notice).toEqual({ key: "error.ROOM_ENDED" });
  });

  it("names whoever ended the chat as a value, not as a baked in sentence", () => {
    useStore.getState().apply({ t: "room.ended", by: "M2", byUsername: "Ben" });
    expect(useStore.getState().ended?.notice).toEqual({
      key: "app.ended.byPeer",
      params: { name: "Ben" },
    });
  });

  it("keeps WHY a translation failed, which used to be dropped on the floor", () => {
    useStore.setState({ lines: [line()] });
    useStore.getState().apply({
      t: "translation.failed",
      lineId: "L1",
      status: "budget_exceeded",
      retriable: false,
      reason: "DAILY_CAP",
    });
    expect(useStore.getState().lines[0]?.failureReason).toBe("DAILY_CAP");
  });
});

// The store reads the browser's language at MODULE SCOPE, so it runs the moment anything
// imports it, including in environments that have no browser globals at all. Node 20 has no
// global navigator (Node 21 added one), and the suite runs in the node environment, so an
// unguarded read threw ReferenceError and took EVERY client suite down with it on the pinned
// CI runtime while passing on a newer Node locally.
describe("initialUiDialect", () => {
  const real = globalThis.navigator;
  afterEach(() => {
    vi.stubGlobal("navigator", real);
  });

  it("falls back when there is no navigator at all", () => {
    vi.stubGlobal("navigator", undefined);
    expect(initialUiDialect()).toBe(FALLBACK_DIALECT);
  });

  it("falls back when the browser offers a language nothing matches", () => {
    vi.stubGlobal("navigator", { language: "qq-ZZ" });
    expect(initialUiDialect()).toBe(FALLBACK_DIALECT);
  });

  it("takes the browser's dialect when the catalog knows it", () => {
    vi.stubGlobal("navigator", { language: "es-AR" });
    expect(initialUiDialect()).toBe("es-AR");
  });

  it("takes a dialect of the right language when only the base matches", () => {
    vi.stubGlobal("navigator", { language: "es" });
    expect(initialUiDialect()).toBe("es-AR");
  });
});
