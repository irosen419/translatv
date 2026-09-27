// The Web Speech API adapter, including the restart supervisor.
//
// This is the highest risk runtime surface in the project. On the cloud path the engine stops
// after roughly 7 seconds of silence and caps a session near 60 seconds, and the obvious fix,
// calling start() again from onend, gets request throttled into a dead session. A naive
// supervisor is worse than none: it turns a recoverable stall into a permanent one and then
// spins the CPU doing it.
//
// Two findings from docs/proposals/vt-0001.md shape this file:
//
//   start(audioTrack) IS implemented (verified in Chrome 141, with a control case proving the
//     argument is type checked rather than ignored). Passing the same echo cancelled track
//     WebRTC is sending means the recognizer inherits the AEC, so the remote speaker's voice
//     coming out of the local speakers does not get transcribed as the local user.
//
//   on device recognition is available via processLocally, and reports "downloadable" for both
//     en-US and es-AR. When it engages, audio never leaves the machine AND the cloud session
//     limits stop applying, which makes the supervisor below mostly dormant.

import type { CopyRef } from "../i18n/copy.js";
import type { SttAdapter, SttCapabilities, SttEvents, SttStatus } from "./types.js";

/** Base restart delay. Doubles per consecutive rapid failure. */
const BASE_RESTART_MS = 250;
const MAX_RESTART_MS = 8_000;
/** A restart sooner than this after a start counts as a rapid cycle. */
const RAPID_CYCLE_MS = 1_000;
/** Consecutive rapid cycles before giving up and asking the user to intervene. */
const MAX_CONSECUTIVE_ERRORS = 6;
/**
 * Proactive recycle interval.
 *
 * Long lived recognition objects are documented to degrade until the browser is restarted.
 * Tearing the object down and building a fresh one during a silence gap costs a sub second gap
 * and avoids that cliff entirely.
 */
const RECYCLE_MS = 4 * 60_000;
/** How long to wait on an on device model download before falling through to the cloud path. */
const INSTALL_TIMEOUT_MS = 20_000;

/**
 * How long to wait for `SpeechRecognition.available()` before treating the answer as unknown.
 *
 * Reported from an iPhone on Safari: the probe's promise never settled. It was awaited in two
 * places with nothing bounding the wait, and the try/catch around each one does not help, because
 * a promise that never resolves never rejects either. The pre join screen renders no notice at
 * all until the probe answers, and start() spawns recognition only after it, so one stalled
 * promise produced both a screen that said nothing and a call with no subtitles, silently.
 *
 * Generous rather than short, which is the opposite of the first version of this.
 *
 * The two failures are not symmetric. Waiting too long costs seconds at the start of a call on
 * an engine that was never going to answer. Giving up too early throws away a REAL answer from
 * an engine that is merely slow, and the loss is silent and privacy shaped: the adapter falls to
 * the cloud path and the audio goes to the browser vendor on a device where it did not have to.
 * A cold first call is exactly when a working engine is slowest, so a tight budget misses in the
 * case it can least afford to.
 *
 * ONE value, used by both callers, deliberately. Splitting it looks attractive, since the pre
 * join probe runs while someone is still typing their name and blocks nothing, while this same
 * wait during start() is speech nobody is transcribing. But the two answers have to agree: a
 * generous probe on the pre join screen and a tight one in start() would put "on device speech
 * recognition is available" on screen and then use the cloud anyway. A notice that lies about
 * where the audio went is worse than either timeout.
 */
export const PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask whether the on device model is available, and take "no answer" for an answer.
 *
 * Null means we could not find out, which is deliberately NOT the same value as "not available".
 * Both callers treat it as a reason to use the cloud path, but only one of them should ever claim
 * the audio stayed on the machine, and that claim needs a real yes.
 */
async function probeAvailability(
  SR: SpeechRecognitionStatics,
  language: string,
): Promise<string | null> {
  try {
    return await Promise.race([
      SR.available?.({ langs: [language], processLocally: true }) ?? Promise.resolve(null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS)),
    ]);
  } catch {
    return null;
  }
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  processLocally?: boolean;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }>;
}

interface SpeechRecognitionStatics {
  available?(options: { langs: string[]; processLocally: boolean }): Promise<string>;
  install?(options: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

function ctor(): (SpeechRecognitionCtor & SpeechRecognitionStatics) | null {
  const w = globalThis as unknown as Record<string, unknown>;
  return (w["SpeechRecognition"] ?? w["webkitSpeechRecognition"] ?? null) as
    | (SpeechRecognitionCtor & SpeechRecognitionStatics)
    | null;
}

export async function detectCapabilities(language: string): Promise<SttCapabilities> {
  const SR = ctor();
  if (!SR) {
    return {
      supported: false,
      onDeviceAvailable: false,
      notice: { key: "stt.none" },
    };
  }

  let onDeviceAvailable = false;
  if (typeof SR.available === "function") {
    const status = await probeAvailability(SR, language);
    onDeviceAvailable = status === "available" || status === "downloadable";
  }

  return { supported: true, onDeviceAvailable };
}

export class WebSpeechAdapter implements SttAdapter {
  private recognition: SpeechRecognitionLike | null = null;
  private track: MediaStreamTrack | null = null;
  private language = "en-US";

  private intentionalStop = false;
  private consecutiveErrors = 0;
  private lastStartAt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private recycleTimer: ReturnType<typeof setInterval> | null = null;
  private onDevice = false;
  private pendingInterim = "";
  private started = false;
  private preferOnDevice: boolean;

  /**
   * preferOnDevice defaults to true, which keeps the historical behavior of taking the on device
   * model whenever it is installable. It is a preference rather than a fact: on device is the
   * privacy and no-session-cap win, but Chrome's local model is measurably worse on fast speech,
   * so which one is right depends on the call, and only the user can say.
   */
  constructor(
    private readonly events: SttEvents,
    preferOnDevice = true,
  ) {
    this.preferOnDevice = preferOnDevice;
  }

  get running(): boolean {
    return this.started;
  }

  async start(track: MediaStreamTrack | null, language: string): Promise<void> {
    const SR = ctor();
    if (!SR) {
      this.events.onStatus({
        kind: "blocked",
        reason: "unsupported",
        notice: { key: "stt.unsupported" },
      });
      return;
    }

    this.track = track;
    this.language = language;
    this.intentionalStop = false;
    this.started = true;

    await this.prepareOnDevice(SR, language);
    this.spawn();

    this.recycleTimer = setInterval(() => this.recycle(), RECYCLE_MS);
  }

  /**
   * Try to get the on device model in place before starting.
   *
   * "downloading" is treated as a TIMED state rather than something to wait on indefinitely:
   * a stalled model download is a known Chromium bug, and blocking room entry on it would turn
   * a degraded feature into a broken app. After the timeout we simply use the cloud path.
   */
  private async prepareOnDevice(SR: SpeechRecognitionStatics, language: string): Promise<void> {
    // Checked before available(), so opting out also avoids downloading a model that will never
    // be used, which is a real cost on a phone.
    if (!this.preferOnDevice) {
      this.onDevice = false;
      return;
    }
    if (typeof SR.available !== "function") return;

    const status = await probeAvailability(SR, language);
    // Null is "we never found out", and it must not read as a yes. Falling through to the cloud
    // path is the safe direction: the worst case is audio going to the browser vendor when it
    // did not have to, rather than a claim that it stayed here when nobody confirmed that.
    if (status === null) {
      this.onDevice = false;
      return;
    }

    try {
      if (status === "available") {
        this.onDevice = true;
        return;
      }
      if (status === "downloadable" && typeof SR.install === "function") {
        this.events.onStatus({ kind: "downloading", language });
        const installed = await Promise.race([
          SR.install({ langs: [language], processLocally: true }),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), INSTALL_TIMEOUT_MS)),
        ]);
        this.onDevice = installed === true;
      }
    } catch {
      this.onDevice = false;
    }
  }

  private spawn(): void {
    const SR = ctor();
    if (!SR || this.intentionalStop) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.language;
    if (this.onDevice && "processLocally" in recognition) {
      try {
        recognition.processLocally = true;
      } catch {
        this.onDevice = false;
      }
    }

    recognition.onstart = () => {
      this.lastStartAt = Date.now();
      this.events.onStatus({ kind: "listening", onDevice: this.onDevice });
    };

    /**
     * Which result indices have already been emitted as finals.
     *
     * A CONST INSIDE spawn, captured by the handler below, so its lifetime is exactly this
     * recognition object's lifetime. That is the whole answer to the restart problem: the engine
     * restarts roughly once a minute on the cloud path and is recycled every four minutes by
     * design, each restart builds a fresh object whose results begin at index 0 again, and a
     * high water mark or a field on the adapter carried across that boundary would swallow every
     * final of the next session. There is no reset to remember to call because there is no
     * shared state to reset.
     *
     * Indexed rather than keyed on the text, because "yes" said twice is two real sentences and
     * deduping by content would eat the second one.
     *
     * Recorded only when a final is EMITTED, never when a result is merely seen, because a
     * result legitimately arrives interim and is finalized in a later event.
     */
    const firedFinals = new Set<number>();

    recognition.onresult = (event) => {
      let interim = "";
      // Chrome's `results` is CUMULATIVE for the session under continuous = true, and
      // `resultIndex` points at the first result that CHANGED, not at the first unseen one. So
      // this loop legitimately walks back over results it has already emitted, and without the
      // set above it re-emitted them: a duplicate final for a sentence already on screen, and
      // one more PAID translation call for it. The client store cannot catch that either, since
      // its dedupe is keyed on a server minted lineId and a resend gets a fresh one.
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) {
          if (firedFinals.has(i)) continue;
          firedFinals.add(i);
          this.pendingInterim = "";
          this.events.onFinal(text);
        } else {
          interim += `${text} `;
        }
      }
      if (interim) {
        this.pendingInterim = interim.trim();
        this.events.onInterim(this.pendingInterim);
      }
    };

    recognition.onerror = (event) => this.onError(event.error);
    recognition.onend = () => this.onEnd();

    this.recognition = recognition;

    // start(track) is the primary path. The catch is for engines that predate the parameter,
    // where the argument is a TypeError rather than a runtime problem; those fall back to the
    // default input device, which costs a second microphone acquisition but still works.
    try {
      if (this.track && this.track.kind === "audio" && this.track.readyState === "live") {
        recognition.start(this.track);
      } else {
        recognition.start();
      }
    } catch (error) {
      if (error instanceof TypeError) {
        try {
          recognition.start();
        } catch {
          this.fail({ key: "stt.wontStart" });
        }
      } else if ((error as { name?: string }).name === "InvalidStateError") {
        // Already running. Not an error worth surfacing; the existing session continues.
      } else {
        this.fail({ key: "stt.wontStart" });
      }
    }
  }

  private onError(code: string): void {
    switch (code) {
      case "no-speech":
        // Entirely benign. Someone was quiet. Counting this as an error would exhaust the
        // backoff budget during an ordinary pause in conversation.
        return;
      case "aborted":
        // Benign when we did it. Otherwise it is transient and onend will handle the restart.
        return;
      case "network":
        // The cloud recognizer is unreachable. Back off hard rather than hammering it, and say
        // so, because silent captions with a working call is confusing.
        this.consecutiveErrors = Math.max(this.consecutiveErrors, 2);
        this.events.onStatus({ kind: "reconnecting", attempt: this.consecutiveErrors });
        return;
      case "audio-capture":
        this.stopInternal();
        this.events.onStatus({
          kind: "blocked",
          reason: "no-microphone",
          notice: { key: "stt.noMicrophone" },
        });
        return;
      case "not-allowed":
      case "service-not-allowed":
        // TERMINAL. Retrying a denied permission spins forever and never recovers, so this
        // path must stop and tell the user what to do.
        this.stopInternal();
        this.events.onStatus({
          kind: "blocked",
          reason: "permission",
          notice: { key: "stt.permission" },
        });
        return;
      case "language-not-supported": {
        // Fall back to the base language rather than dying: es-AR unsupported does not mean
        // Spanish is unsupported.
        const base = this.language.split("-")[0];
        if (base && base !== this.language) {
          this.language = base;
          return;
        }
        this.fail({ key: "stt.languageUnsupported" });
        return;
      }
      default:
        return;
    }
  }

  private onEnd(): void {
    if (this.intentionalStop) {
      this.events.onStatus({ kind: "idle" });
      return;
    }

    // A session that ends while interim text is pending would lose that speech across the
    // boundary. Commit it as a final instead, so a sentence interrupted by the 60 second cap
    // still reaches the transcript.
    if (this.pendingInterim) {
      this.events.onFinal(this.pendingInterim);
      this.pendingInterim = "";
    }

    const alive = Date.now() - this.lastStartAt;
    if (alive < RAPID_CYCLE_MS) {
      this.consecutiveErrors += 1;
    } else {
      // A session that ran for a while then ended is the ordinary silence timeout, not a
      // failure, so the backoff resets.
      this.consecutiveErrors = 0;
    }

    if (this.consecutiveErrors > MAX_CONSECUTIVE_ERRORS) {
      this.fail({ key: "stt.keepsDropping" });
      return;
    }

    const delay = Math.min(
      BASE_RESTART_MS * 2 ** this.consecutiveErrors,
      MAX_RESTART_MS,
    ) + Math.random() * 250;

    if (this.consecutiveErrors > 0) {
      this.events.onStatus({ kind: "reconnecting", attempt: this.consecutiveErrors });
    }

    this.restartTimer = setTimeout(() => {
      if (!this.intentionalStop) this.spawn();
    }, delay);
  }

  /**
   * Rebuild the recognition object, which avoids the long session degradation cliff.
   *
   * force is for changes the user just asked for. The default politeness of waiting for a gap is
   * right for the background timer, but a setting that visibly does nothing until the speaker
   * happens to pause reads as broken, and losing a partial sentence to your own button press is
   * both expected and obviously attributable.
   */
  private recycle(force = false): void {
    if (this.intentionalStop || !this.recognition) return;
    // Only recycle during a gap. Tearing down mid sentence would drop it.
    if (!force && this.pendingInterim) return;
    try {
      this.recognition.abort();
    } catch {
      // The onend handler respawns.
    }
  }

  private fail(notice: CopyRef): void {
    this.stopInternal();
    this.events.onStatus({ kind: "failed", notice });
  }

  private stopInternal(): void {
    this.intentionalStop = true;
    this.started = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.recycleTimer) clearInterval(this.recycleTimer);
    this.restartTimer = null;
    this.recycleTimer = null;
  }

  stop(): void {
    this.stopInternal();
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        // Already stopped.
      }
    }
    this.recognition = null;
    this.events.onStatus({ kind: "idle" });
  }

  /**
   * Switch engines mid call.
   *
   * Turning the preference back on has to re-run prepareOnDevice: spawn() only reads this.onDevice
   * and never re-checks availability, so without this the switch back to on device would silently
   * keep using the cloud.
   */
  async setPreferOnDevice(value: boolean): Promise<void> {
    if (value === this.preferOnDevice) return;
    this.preferOnDevice = value;

    if (!value) {
      this.onDevice = false;
    } else if (this.started) {
      const SR = ctor();
      if (SR) await this.prepareOnDevice(SR, this.language);
    }

    this.recycle(true);
  }

  setLanguage(language: string): void {
    if (language === this.language) return;
    this.language = language;
    // Recycle so the new language takes effect. Changing lang on a running instance is ignored
    // by the engine until the next session, which looks like the setting silently not working.
    this.recycle();
  }
}
