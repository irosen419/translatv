import { describe, expect, it, vi } from "vitest";
import type { Phase } from "../state/store.js";
import { adoptCameraTrack } from "./cameraHandoff.js";

/** A track that records whether anything ever stopped it. */
function fakeTrack(): MediaStreamTrack & { stop: ReturnType<typeof vi.fn> } {
  return { kind: "video", stop: vi.fn() } as unknown as MediaStreamTrack & {
    stop: ReturnType<typeof vi.fn>;
  };
}

/** A stream that only does the two things the handoff asks of it. */
function fakeStream(tracks: MediaStreamTrack[] = []): MediaStream {
  const held = [...tracks];
  return {
    addTrack: (track: MediaStreamTrack) => held.push(track),
    getTracks: () => held,
  } as unknown as MediaStream;
}

function call(phase: Phase, stream: MediaStream | null) {
  return { phase, stream };
}

describe("adoptCameraTrack", () => {
  it("puts the track in the stream the call is already sending", () => {
    const audio = { kind: "audio" } as MediaStreamTrack;
    const stream = fakeStream([audio]);
    const track = fakeTrack();

    const adopted = adoptCameraTrack(track, call("room", stream));

    // The SAME stream object, not a fresh one. Both senders then quote one msid, so the peer sees
    // one person rather than two.
    expect(adopted).toBe(stream);
    expect(stream.getTracks()).toEqual([audio, track]);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it("stops a track that arrives after the call ended", () => {
    // The permission prompt can sit open indefinitely, so the room can end underneath it. Nothing
    // else holds this track: leaving it running leaves the camera light on for the life of the tab.
    const track = fakeTrack();

    const adopted = adoptCameraTrack(track, call("ended", null));

    expect(adopted).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("stops a track when the media is gone but the phase has not caught up yet", () => {
    // Ending a chat tears the local media down immediately and only reaches the ended phase when
    // room.ended comes back from the server. In between, the phase alone would say we are live.
    const track = fakeTrack();

    const adopted = adoptCameraTrack(track, call("room", null));

    expect(adopted).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("refuses to publish into a stream that outlived its room", () => {
    // Belt and braces for the reverse of the case above: a stream still in hand while the phase
    // says the room is over is not a call to add a camera to either.
    const stream = fakeStream();
    const track = fakeTrack();

    const adopted = adoptCameraTrack(track, call("ended", stream));

    expect(adopted).toBeNull();
    expect(stream.getTracks()).toEqual([]);
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
