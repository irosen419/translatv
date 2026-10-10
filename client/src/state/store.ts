// Client state.
//
// zustand rather than Context, because interim transcript updates arrive at roughly 5 per
// second and a Context update re-renders the entire subtree. Selector scoped subscriptions
// keep a subtitle update from repainting the video element.
//
// The live interim line is deliberately NOT in this store at all: it is written straight to a
// DOM node through a ref in SubtitleOverlay. That is the one place the React model is broken on
// purpose, and it is worth it because that line changes faster than anything else on screen.

import { create } from "zustand";
import type {
  Member,
  RenderedLine,
  ServerMessage,
  SignupMode,
  TranslationFailureCode,
  TranslationStatus,
} from "@translatv/shared";
import { detectDialect, FALLBACK_DIALECT } from "@translatv/shared";
import type { CopyRef } from "../i18n/copy.js";
import { errorCopyKey } from "../i18n/codes.js";
import type { PeerState } from "../rtc/PeerConnection.js";
import type { SttStatus } from "../stt/types.js";
import type { SessionState } from "../lib/session.js";

export type Phase = "landing" | "prejoin" | "room" | "ended";

export interface EndedInfo {
  reason: "ended" | "left" | "kicked" | "gone";
  /**
   * WHAT to say, not the words.
   *
   * A sentence stored here would be frozen in whatever language was current when the room
   * ended, and the ended screen is exactly where someone reaches for the dialect they can
   * actually read. A ref is rendered at paint time, so it follows the picker like everything
   * else does.
   */
  notice: CopyRef;
}

interface State {
  phase: Phase;
  /**
   * The dialect the INTERFACE is in.
   *
   * The same one the person picked to speak, by owner decision: there is no second control. It
   * lives here rather than being read off `me` because the landing and prejoin screens have no
   * `me` yet and still have to be readable, and because it has to survive the gap between
   * picking a dialect in the form and the server confirming it.
   */
  uiDialect: string;
  /**
   * Who is signed in, mirrored from the SessionManager (lib/session.ts) so screens repaint the
   * moment someone signs in or out. Starts "signedOut" and is set by App.tsx when it loads, from
   * what the session manager finds in storage, so the first render already shows the right screen.
   *
   * NOT an authority on anything: the server decides who may do what, from the access token on
   * each request and each socket. This answers "which screen to show".
   */
  session: SessionState;
  /**
   * Whether signing up needs an invite, from /healthz. Starts "invite", before the server has
   * answered, because the two wrong guesses are not equal: showing an invite field on an open
   * server costs one ignored field, hiding it on an invite only one guarantees a refusal.
   */
  signupMode: SignupMode;
  /** Prefilled from a /r/<code> link so a shared link lands straight on the join form. */
  pendingCode: string | null;

  code: string | null;
  selfId: string | null;
  me: Member | null;
  peer: Member | null;
  polite: boolean;
  iceServers: RTCIceServer[];

  lines: RenderedLine[];

  peerState: PeerState;
  sttStatus: SttStatus;
  socketState: "connected" | "reconnecting" | "closed";
  /**
   * Why translation is not going to work for this call, or null.
   *
   * A REASON rather than a boolean, mirroring TranslationService.disabledReason on the server so
   * the two sides model the same fact the same way. The boolean this replaced was written here on
   * a terminal failure and read by nothing at all: not one component, not one selector. So a
   * server with no API key silently stopped translating for the whole session and the only
   * evidence on screen was a small marker on each individual line.
   *
   * A wire CODE, not the server's sentence. It is what distinguishes a missing key from a broken
   * one from a dialect nobody could resolve, and as a code the reader is told which of those it
   * was in their own language rather than in the server operator's.
   *
   * Only a NON RETRIABLE unavailable sets it. A timeout and an empty model reply both arrive as
   * "unavailable" too, and one slow sentence is not the session going down.
   */
  translationUnavailable: TranslationFailureCode | null;

  // YOUR OWN media state, and the authority for it: these drive the local tracks. The same two
  // names also exist on `me` and `peer` as the copy that went over the wire. Room.tsx
  // destructures these bare ones, so writing `micEnabled` where `peer?.micEnabled` was meant
  // compiles cleanly and is wrong. Rule: never destructure a peer field into a bare name, and
  // treat `me.micEnabled` as kept in sync but never read for rendering your own controls.
  micEnabled: boolean;
  cameraEnabled: boolean;
  hasVideo: boolean;
  micLevel: number;

  ended: EndedInfo | null;
  /** Why the last attempt failed, as a ref the reader's own copy files answer. */
  error: CopyRef | null;

  setPhase(phase: Phase): void;
  setUiDialect(dialect: string): void;
  setSession(session: SessionState): void;
  setSignupMode(mode: SignupMode): void;
  setPendingCode(code: string | null): void;
  apply(message: ServerMessage): void;
  reset(): void;

  setPeerState(state: PeerState): void;
  setSttStatus(status: SttStatus): void;
  setSocketState(state: State["socketState"]): void;
  setMedia(patch: Partial<Pick<State, "micEnabled" | "cameraEnabled" | "hasVideo" | "micLevel">>): void;
  setEnded(info: EndedInfo): void;
  setError(error: CopyRef | null): void;
}

/**
 * The dialect the interface starts in, before anyone has chosen one.
 *
 * The browser's own language is the best guess available, and it is the same guess the prejoin
 * picker starts on, so the first screen is already in the right language for most people rather
 * than English until they touch something.
 *
 * Read behind a guard, because this runs at MODULE SCOPE: it executes the moment anything
 * imports the store, including in environments that have no browser globals at all. Node 20 has
 * no global navigator (Node 21 added one) and the client suite runs in the node environment, so
 * an unguarded read threw ReferenceError and took EVERY client suite down with it on the Node
 * version CI pinned then (20), while passing locally on a newer one. CI is on 22 now, which has a
 * global navigator; the guard stays for any environment without one.
 */
export function initialUiDialect(): string {
  const language = typeof navigator === "undefined" ? undefined : navigator.language;
  return detectDialect(language)?.code ?? FALLBACK_DIALECT;
}

export const useStore = create<State>((set, get) => ({
  phase: "landing",
  uiDialect: initialUiDialect(),
  session: { status: "signedOut", user: null },
  signupMode: "invite",
  pendingCode: null,

  code: null,
  selfId: null,
  me: null,
  peer: null,
  polite: true,
  iceServers: [],

  lines: [],

  peerState: "new",
  sttStatus: { kind: "idle" },
  socketState: "closed",
  translationUnavailable: null,

  micEnabled: true,
  cameraEnabled: false,
  hasVideo: false,
  micLevel: 0,

  ended: null,
  error: null,

  setPhase: (phase) => set({ phase }),
  setUiDialect: (uiDialect) => set({ uiDialect }),
  setSession: (session) => set({ session }),
  setSignupMode: (signupMode) => set({ signupMode }),
  setPendingCode: (pendingCode) => set({ pendingCode }),
  setPeerState: (peerState) => set({ peerState }),
  setSttStatus: (sttStatus) => set({ sttStatus }),
  setSocketState: (socketState) => set({ socketState }),
  setMedia: (patch) => set(patch),
  setEnded: (ended) => set({ ended, phase: "ended" }),
  setError: (error) => set({ error }),

  reset: () =>
    set({
      phase: "landing",
      code: null,
      selfId: null,
      me: null,
      peer: null,
      lines: [],
      peerState: "new",
      sttStatus: { kind: "idle" },
      ended: null,
      error: null,
      // Cleared, unlike the media flags. This is a claim about a SERVER, and the next room may
      // not be on the same one, or an operator may have fixed the key in between. Showing
      // "translation unavailable" in a room where it works is worse than the half second it
      // takes a genuine terminal failure to set it again on the first line.
      translationUnavailable: null,
    }),

  apply: (message) => {
    switch (message.t) {
      case "room.created":
        set({
          phase: "room",
          code: message.code,
          selfId: message.selfId,
          me: message.you,
          // The server's copy of the dialect is the one that wins. A resume can hand back a
          // dialect chosen in a previous session, and the interface has to follow the seat
          // rather than whatever this tab last guessed.
          uiDialect: message.you.dialect,
          peer: null,
          polite: message.polite,
          iceServers: message.iceServers,
          error: null,
        });
        return;

      case "room.joined":
        set({
          phase: "room",
          code: message.code,
          selfId: message.selfId,
          me: message.you,
          uiDialect: message.you.dialect,
          peer: message.peer,
          polite: message.polite,
          iceServers: message.iceServers,
          lines: message.snapshot.lines,
          error: null,
        });
        return;

      case "peer.joined":
        set({ peer: message.peer });
        return;

      case "peer.left":
        set({ peer: null, peerState: "new" });
        return;

      case "peer.updated":
        set((s) =>
          s.peer && s.peer.id === message.peerId
            ? {
                peer: {
                  ...s.peer,
                  ...(message.username !== undefined ? { username: message.username } : {}),
                  ...(message.dialect !== undefined ? { dialect: message.dialect } : {}),
                  ...(message.micEnabled !== undefined ? { micEnabled: message.micEnabled } : {}),
                  ...(message.cameraEnabled !== undefined
                    ? { cameraEnabled: message.cameraEnabled }
                    : {}),
                  ...(message.wantsTranslation !== undefined
                    ? { wantsTranslation: message.wantsTranslation }
                    : {}),
                },
              }
            : {},
        );
        return;

      case "peer.state":
        set((s) =>
          s.peer && s.peer.id === message.peerId
            ? { peer: { ...s.peer, connection: message.connection } }
            : {},
        );
        return;

      case "room.ended":
        set({
          ended: {
            reason: "ended",
            notice: { key: "app.ended.byPeer", params: { name: message.byUsername } },
          },
          phase: "ended",
        });
        return;

      case "transcript.final":
        // Guard against a duplicate arriving after a resume replayed the snapshot.
        set((s) =>
          s.lines.some((l) => l.lineId === message.line.lineId)
            ? {}
            : { lines: [...s.lines, message.line] },
        );
        return;

      case "translation.pending":
        set((s) => ({
          lines: s.lines.map((l) =>
            l.lineId === message.lineId ? { ...l, translationStatus: "pending" as const } : l,
          ),
        }));
        return;

      // Only the retry path sends this. A fresh line that needs no translation arrives already
      // marked on transcript.final. `translated` stays null: there is no translation, and the
      // renderers show the original in the primary slot rather than treating it as a failure.
      case "translation.skipped":
        set((s) => ({
          lines: s.lines.map((l) =>
            // Same revision guard as translation.result: a skip landing after a correction must
            // not undo the correction.
            l.lineId === message.lineId && message.revision >= l.revision
              ? {
                  ...l,
                  translated: null,
                  translationStatus: "skipped" as const,
                  // The reason used to be dropped on the floor here, so a line that came back
                  // skipped after a retry lost the one fact that explains it.
                  skipReason: message.reason,
                  revision: message.revision,
                }
              : l,
          ),
        }));
        return;

      case "translation.result":
        set((s) => ({
          // Proof beats memory: a model result means translation demonstrably works RIGHT NOW, so
          // any earlier claim that it does not is stale and comes down. Only "model" counts. An
          // echo is a line that needed no translation and a correction is one a human typed, and
          // neither of those went anywhere near the API.
          translationUnavailable: message.origin === "model" ? null : s.translationUnavailable,
          lines: s.lines.map((l) =>
            // The revision guard: a stale result arriving after a correction must not undo it.
            l.lineId === message.lineId && message.revision >= l.revision
              ? {
                  ...l,
                  translated: message.text,
                  translationStatus: "ok" as TranslationStatus,
                  // A line that HAS a translation was not skipped, whatever it used to be. Same
                  // clearing RoomSession.setTranslation does, so the two copies of the line
                  // cannot disagree about it.
                  skipReason: null,
                  revision: message.revision,
                }
              : l,
          ),
        }));
        return;

      case "translation.failed":
        set((s) => ({
          // Terminal only. Retriable failures (a timeout, an empty reply, a rate limit) are the
          // ordinary weather of a live call and must not raise a session wide alarm.
          translationUnavailable:
            message.status === "unavailable" && !message.retriable
              ? message.reason
              : s.translationUnavailable,
          lines: s.lines.map((l) =>
            l.lineId === message.lineId
              ? {
                  ...l,
                  // The failure fallback: show the ORIGINAL where the translation goes, marked.
                  // Never a blank line and never a permanent spinner.
                  translated: l.text,
                  translationStatus: message.status,
                  // Kept so the marker and the retry button can say WHY in the reader's own
                  // language. The server used to send that sentence in English and this handler
                  // dropped it on the floor, so nothing on screen ever explained a failure.
                  failureReason: message.reason,
                  // A failure is not a skip, so no quiet "nothing needed translating" note.
                  skipReason: null,
                }
              : l,
          ),
        }));
        return;

      case "glossary.updated":
        // Nothing on screen shows the room's glossary. The client kept it only for the
        // transcript download, which is gone (owner decision 2026-09-28): corrections now reach
        // the next call through the account, saved by the server when the call ends.
        return;

      case "error":
        set({ error: { key: errorCopyKey(message.code) } });
        if (message.fatal) {
          // A fatal error before entering a room (the room is full, the code is dead, the code
          // is wrong) sends the user back to the form. The message MUST travel with them:
          // dropping it leaves someone staring at an unchanged join form wondering why nothing
          // happened, which is the worst possible outcome of a perfectly clear server error.
          const inRoom = get().phase === "room";
          set({
            ended: inRoom ? { reason: "gone", notice: { key: errorCopyKey(message.code) } } : null,
            phase: inRoom ? "ended" : "landing",
          });
        }
        return;

      default:
        return;
    }
  },
}));
