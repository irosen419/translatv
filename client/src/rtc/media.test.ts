import { afterEach, describe, expect, it, vi } from "vitest";
import { copyFor } from "../i18n/copy.js";
import { acquireCameraTrack, acquireMedia, videoConstraints, type MediaError } from "./media.js";

/**
 * The sentence an English reader would actually see for a failure.
 *
 * Acquisition returns a copy key, not prose, so the reader's own dialect decides the words. The
 * assertions below are still about the WORDS, because the thing worth protecting is what someone
 * is told to do about a broken camera, not which constant was picked.
 */
function englishFor(result: MediaError | object): string {
  return "notice" in result ? copyFor("en-US").ref(result.notice as never) : "";
}

// vi.stubGlobal rather than Reflect.set, which only worked here by accident: it needs the global
// to be a plain writable property, and it silently returns false instead of throwing when it is
// not. Node 21 added a real global `navigator` as a getter only accessor, so on that runtime the
// stub would quietly do nothing and the success tests would fail for a reason nothing on screen
// explains. stubGlobal defines the property outright and restores it afterwards.

/** Pretend the device reports the given orientation to a media query. */
function setOrientation(portrait: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("portrait") ? portrait : !portrait,
    media: query,
  }));
}

/** Fake out navigator.mediaDevices.getUserMedia for a single call. */
function stubGetUserMedia(handler: () => Promise<MediaStream>): void {
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: handler } });
}

/** A fake video track, just real enough for acquireCameraTrack to hand back. */
function fakeVideoTrack(): MediaStreamTrack {
  return { kind: "video" } as MediaStreamTrack;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("videoConstraints", () => {
  /*
   * These used to assert a width and a height chosen from the screen's orientation. That request
   * is what this change removes, so the assertions are about its ABSENCE now.
   *
   * The reason is a real call. A caller on a phone arrived looking as though the camera had
   * zoomed in on her face, and it survived the display side fix that letterboxes a mismatched
   * frame rather than cropping it. A frame that arrives already cropped cannot be un cropped by
   * how it is displayed. Asking a phone for 720x1280 when its sensor offers no such format makes
   * the camera crop to produce one, and that crop is baked in before the frame is ever encoded.
   */
  it("asks for exactly the same thing in either orientation", () => {
    // The WHOLE object, in both orientations, and that is the point rather than pedantry.
    //
    // The first version of this checked only that height and aspectRatio were absent, and review
    // slipped two mutants past it: reinstating the orientation branch with a 720 wide request in
    // portrait passed all ten tests, which is a real regression on exactly the phones this change
    // is for. The full object assertion under portrait is what was missing, because the only
    // strict toEqual ran with matchMedia stubbed away entirely.
    for (const portrait of [true, false]) {
      setOrientation(portrait);
      expect(videoConstraints()).toEqual({ width: { ideal: 1280 } });
    }
  });

  it("still asks for a usable resolution rather than whatever the camera defaults to", () => {
    // Dropping the constraints entirely is the other obvious move and it is worse: an
    // unconstrained getUserMedia commonly lands on 640x480, which is a visible downgrade on
    // every desktop to fix a problem that only phones have.
    setOrientation(false);
    expect(videoConstraints().width).toEqual({ ideal: 1280 });
  });

  it("asks the same thing when the browser cannot answer an orientation query", () => {
    // There is nothing left for orientation to decide, so an engine without matchMedia is no
    // longer a special case to guess around.
    vi.stubGlobal("matchMedia", undefined);
    expect(videoConstraints()).toEqual({ width: { ideal: 1280 } });
  });
});

describe("acquireCameraTrack", () => {
  it("hands back a live video track on success", async () => {
    const track = fakeVideoTrack();
    stubGetUserMedia(async () => ({ getVideoTracks: () => [track] }) as unknown as MediaStream);

    const result = await acquireCameraTrack();
    expect("track" in result && result.track).toBe(track);
  });

  it("reports denial without touching audio, naming the camera specifically", async () => {
    stubGetUserMedia(async () => {
      throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    });

    const result = await acquireCameraTrack();
    expect("kind" in result && result.kind).toBe("denied");
    expect(englishFor(result)).toMatch(/camera/i);
  });

  it("reports a missing camera distinctly from a missing microphone", async () => {
    stubGetUserMedia(async () => {
      throw Object.assign(new Error("gone"), { name: "NotFoundError" });
    });

    const result = await acquireCameraTrack();
    expect("kind" in result && result.kind).toBe("no-device");
    expect(englishFor(result)).toMatch(/camera/i);
  });

  it("refuses on an insecure context, exactly like the microphone path", async () => {
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => Promise.reject(new Error("should not be called")) },
    });

    const result = await acquireCameraTrack();
    expect("kind" in result && result.kind).toBe("insecure");
  });
});

/**
 * The remedy has to match where the person is standing.
 *
 * "Reload this page" is free advice at the prejoin screen and expensive advice mid call: a reload
 * drops the WebRTC connection and the room seat, so someone who follows it to fix their camera
 * loses the call they were trying to add a camera to.
 */
describe("failure remedies", () => {
  /**
   * Every message a device failure can produce, for one entry point.
   *
   * Rendered through the English copy files, because what is being asserted is the SENTENCE a
   * person reads. Acquisition hands back a key now, and a test that only compared keys would
   * pass happily while the sentence behind one of them told a mid call user to reload.
   */
  async function messagesFor(acquire: () => Promise<MediaError | object>): Promise<string[]> {
    const names = ["NotAllowedError", "NotFoundError", "NotReadableError", "AbortError"];
    const messages: string[] = [];
    for (const name of names) {
      stubGetUserMedia(async () => {
        throw Object.assign(new Error("nope"), { name });
      });
      messages.push(englishFor(await acquire()));
    }
    return messages;
  }

  it("keeps telling a prejoin user to reload, word for word", async () => {
    const messages = await messagesFor(() => acquireMedia(false));

    expect(messages).toEqual([
      "Microphone access was blocked. Allow it in your browser's site settings, then reload this page.",
      "No microphone was found. Connect one and reload.",
      "Your microphone is in use by another app. Close it and reload.",
      "Could not access your microphone.",
    ]);
  });

  it("never tells a mid call user to reload, since that would cost them their seat", async () => {
    const messages = await messagesFor(acquireCameraTrack);

    for (const message of messages) expect(message).not.toMatch(/reload/i);
  });

  it("still tells a mid call user what to do about it", async () => {
    const messages = await messagesFor(acquireCameraTrack);

    expect(messages).toEqual([
      "Camera access was blocked. Allow it in your browser's site settings, then try again.",
      "No camera was found. Connect one and try again.",
      "Your camera is in use by another app. Close it and try again.",
      "Could not access your camera.",
    ]);
  });
});
