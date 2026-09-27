// Microphone and camera acquisition.
//
// Two things here are load bearing and non obvious:
//
//   echoCancellation must be ON, because the SAME track is handed to speech recognition. That
//     is what stops the remote speaker's voice, coming out of the local speakers, from being
//     transcribed and attributed to the local user. See docs/proposals/vt-0001.md.
//
//   NO microphone picker. SpeechRecognition uses the OS default input device and ignores any
//     deviceId passed to getUserMedia, so a picker in the UI would silently fail to affect
//     transcription. Shipping one would be a lie about what the control does.

import type { CopyRef } from "../i18n/copy.js";

export interface MediaResult {
  stream: MediaStream;
  hasVideo: boolean;
}

export type MediaError =
  | { kind: "denied"; notice: CopyRef }
  | { kind: "no-device"; notice: CopyRef }
  | { kind: "insecure"; notice: CopyRef }
  | { kind: "other"; notice: CopyRef };

/**
 * The device a request was for, which is the word every message here has to name correctly.
 *
 * It also decides the REMEDY, and that is not the coincidence it looks like. A microphone is
 * only ever acquired at the prejoin screen, where "reload this page" is free advice. A camera is
 * only ever acquired on its own mid call, where a reload drops the WebRTC connection and the
 * room seat, so following that advice to fix a camera would cost the user the call they were
 * adding the camera to. A camera failure at prejoin is swallowed entirely, because video is
 * optional there and a broken webcam must not cost somebody the call.
 *
 * The remedy used to be a second parameter and the sentences were assembled from a stem and a
 * tail. That composition does not survive translation: the clauses land in a different order in
 * Spanish and the imperative changes shape per dialect, so each situation is now one whole
 * sentence in the copy files. If a camera ever IS acquired at prejoin, the honest fix is a third
 * set of keys, not a tail glued back on.
 */
type Device = "microphone" | "camera";

/**
 * Camera constraints: a resolution preference, and no opinion about shape.
 *
 * This used to ask for dimensions matching the screen's orientation, on the theory that a frame
 * already the right way round would spare the layout a crop. It caused one instead, further
 * upstream and unfixable. See the body for the measurement.
 *
 * "ideal" rather than "exact" is load bearing: a camera whose only format is 640x480 answers an
 * exact 1280 with OverconstrainedError and the user loses their video, where ideal clamps to the
 * nearest format it does have.
 */
export function videoConstraints(): MediaTrackConstraints {
  // One dimension, and deliberately no second one. We do not get to choose the shape of someone
  // else's camera.
  //
  // This used to ask for 1280x720, or 720x1280 when the screen was upright, on the theory that
  // matching the orientation would stop the layout having to crop. It caused the crop instead.
  //
  // The actor is the BROWSER, not the sensor, which is what makes this measurable rather than
  // folklore. `resizeMode` defaults to permitting `crop-and-scale`, and fitness distance is
  // minimised over the settings dictionary rather than over the device's format list, so a UA is
  // free to hit an exact height by cropping the nearest native format instead of choosing a
  // different one. Chromium does. Measured against a camera pinned to one 1280x720 format:
  //
  //   old, portrait 720x1280      720x720    resizeMode crop-and-scale
  //   new, width ideal 1280       1280x720   resizeMode none
  //
  // A 43 percent horizontal crop, centred, which on a face reads as exactly the zoom that was
  // reported. It lands in the track's own dimensions, so it is upstream of the encoder by
  // construction and nothing downstream can undo it. That is why it outlived the receiving side
  // fix that letterboxes a mismatched frame: the two are different problems.
  //
  // A width alone is a preference the camera can meet at its own aspect ratio. Dropping the
  // constraints entirely is the other obvious move and it is worse: an unconstrained
  // getUserMedia commonly settles on 640x480, a visible downgrade everywhere to fix something
  // only phones suffer.
  //
  // The cost, and it is a real one: the self view thumbnail is a fixed 4/3, or 3/4 on a narrow
  // screen, and fills itself with object-fit: cover. A landscape camera in an upright 3/4 box is
  // therefore cropped, which is exactly what the orientation branch was added to avoid. That
  // trade is taken on purpose. A crop in your own thumbnail is one you can see and lean out of;
  // a crop applied by the sender's camera is invisible to them and unfixable by anyone.
  return { width: { ideal: 1280 } };
}

/**
 * Acquire the microphone, and the camera if requested.
 *
 * Audio is REQUIRED and video is optional, so a camera failure degrades to an audio only call
 * rather than failing the whole thing. Someone with a broken webcam should still be able to
 * talk.
 */
export async function acquireMedia(wantVideo: boolean): Promise<MediaResult | MediaError> {
  const blocked = unavailableReason("microphone");
  if (blocked) return blocked;

  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  if (wantVideo) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: videoConstraints(),
      });
      return { stream, hasVideo: true };
    } catch {
      // Fall through to audio only. Video is optional by design, so a camera problem must not
      // cost the user the call.
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio });
    return { stream, hasVideo: false };
  } catch (error) {
    return describeMediaError(error, "microphone");
  }
}

/**
 * Why getUserMedia cannot even be asked, or null when it can be.
 *
 * Both entry points need the same two checks in the same order, differing only in the device they
 * name, which is the axis describeMediaError already parameterizes.
 */
function unavailableReason(device: Device): MediaError | null {
  if (!globalThis.isSecureContext) {
    return { kind: "insecure", notice: { key: `media.insecure.${device}` } };
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return { kind: "other", notice: { key: "media.unsupported" } };
  }

  return null;
}

/**
 * Acquire a camera track on its own, for turning a camera on mid call.
 *
 * Used when a join started audio only: the peer connection and the audio track already exist, so
 * this hands back a bare track to be added to the existing connection rather than a whole new
 * MediaStream. Video only, unlike acquireMedia, because the audio side is never re-requested here.
 *
 * Failures here get the "retry" remedy, never the prejoin one: the caller is IN a call, and
 * telling them to reload would take the room seat away as the price of a camera.
 */
export async function acquireCameraTrack(): Promise<{ track: MediaStreamTrack } | MediaError> {
  const blocked = unavailableReason("camera");
  if (blocked) return blocked;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
    const track = stream.getVideoTracks()[0];
    if (!track) return { kind: "other", notice: { key: "media.other.camera" } };
    return { track };
  } catch (error) {
    return describeMediaError(error, "camera");
  }
}

function describeMediaError(error: unknown, device: Device): MediaError {
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { kind: "denied", notice: { key: `media.denied.${device}` } };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return { kind: "no-device", notice: { key: `media.noDevice.${device}` } };
  }
  if (name === "NotReadableError") {
    return { kind: "other", notice: { key: `media.inUse.${device}` } };
  }
  return { kind: "other", notice: { key: `media.other.${device}` } };
}

/**
 * An RMS meter on the echo cancelled track.
 *
 * Demoted from load bearing to defensive by the vt-0001 finding: because recognition receives
 * the AEC'd track, echo is already handled. This still earns its place as a "did this person
 * actually speak" filter against spurious finals, and it drives the mic level indicator.
 */
export class LevelMeter {
  private readonly context: AudioContext;
  private readonly analyser: AnalyserNode;
  // Explicitly backed by an ArrayBuffer: getFloatTimeDomainData will not accept a view over a
  // SharedArrayBuffer, and the default Float32Array type is generic over both.
  private readonly buffer: Float32Array<ArrayBuffer>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(track: MediaStreamTrack, private readonly onLevel: (rms: number) => void) {
    const Ctor = (globalThis as unknown as { AudioContext: typeof AudioContext }).AudioContext;
    this.context = new Ctor();
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));
    this.context.createMediaStreamSource(new MediaStream([track])).connect(this.analyser);
    this.timer = setInterval(() => this.sample(), 100);
  }

  private sample(): void {
    this.analyser.getFloatTimeDomainData(this.buffer);
    let sum = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const value = this.buffer[i] ?? 0;
      sum += value * value;
    }
    this.onLevel(Math.sqrt(sum / this.buffer.length));
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    void this.context.close();
  }
}
