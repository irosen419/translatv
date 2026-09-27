import type { CopyRef } from "../i18n/copy.js";

// The engine agnostic speech to text interface.
//
// Exists so swapping to a paid engine (Deepgram, Azure) is a new file implementing this, not a
// rewrite of everything that consumes transcripts. The Web Speech implementation is the default
// because it is free and needs no account; this boundary is what keeps that from being a
// one way door.

export interface SttEvents {
  /** Live, unstable text. Rendered as the original language line while someone is talking. */
  onInterim(text: string): void;
  /** A committed utterance. This is what gets stored and translated. */
  onFinal(text: string): void;
  /** State the UI should surface, so a failure is legible rather than silent. */
  onStatus(status: SttStatus): void;
}

export type SttStatus =
  | { kind: "idle" }
  | { kind: "listening"; onDevice: boolean }
  | { kind: "downloading"; language: string }
  /** Transient. The supervisor is backing off and will retry. */
  | { kind: "reconnecting"; attempt: number }
  /**
   * Terminal. Needs the user to do something, so it must be surfaced with instructions.
   *
   * The instructions travel as a copy ref rather than a sentence. An adapter has no idea which
   * language the person in front of it reads, and the one thing worse than no subtitles is
   * being told why in a language you do not speak.
   */
  | { kind: "blocked"; reason: "permission" | "no-microphone" | "unsupported"; notice: CopyRef }
  /** Terminal after repeated failure. A manual restart control should appear. */
  | { kind: "failed"; notice: CopyRef };

export interface SttAdapter {
  /**
   * Begin recognizing.
   *
   * The track is the SAME one being sent over WebRTC. Passing it is what makes echo
   * cancellation apply to recognition: see docs/proposals/vt-0001.md. Adapters that cannot
   * accept a track fall back to the default input device.
   */
  start(track: MediaStreamTrack | null, language: string): Promise<void>;
  stop(): void;
  setLanguage(language: string): void;
  readonly running: boolean;
}

export interface SttCapabilities {
  supported: boolean;
  /** Whether the engine can run without sending audio off the device. */
  onDeviceAvailable: boolean;
  /** Why not, when it is not supported at all. */
  notice?: CopyRef;
}
