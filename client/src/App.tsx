import { useCallback, useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@translatv/shared";

import { Landing } from "./components/Landing.jsx";
import { PreJoin } from "./components/PreJoin.jsx";
import { Room } from "./components/Room.jsx";
import { codeFromPath } from "./lib/code.js";
import { adoptCameraTrack } from "./rtc/cameraHandoff.js";
import { acquireCameraTrack, acquireMedia, LevelMeter } from "./rtc/media.js";
import { PeerConnection } from "./rtc/PeerConnection.js";
import { SignalingSocket, socketUrl } from "./net/socket.js";
import { useStore } from "./state/store.js";
import { AuthScreen } from "./components/AuthScreen.jsx";
import { browserLock, browserStore, SessionManager } from "./lib/session.js";
import { PreferenceSync } from "./lib/preferences.js";
import { savedCorrectionsRegistry } from "./lib/savedCorrections.js";
import { correctionMessage } from "./lib/correction.js";
import { useCopy } from "./i18n/useCopy.js";
import type { CopyRef } from "./i18n/copy.js";
import { WebSpeechAdapter } from "./stt/WebSpeechAdapter.js";

const STT_ENGINE_KEY = "vt.stt.preferOnDevice";

/**
 * Which recognizer to use, remembered across reloads.
 *
 * Defaults to on device, which is the historical behavior. Anything other than an explicit
 * "false" means on device, so a corrupted or absent value fails toward the private option rather
 * than quietly starting to ship audio to a cloud service.
 */
function loadPreferOnDevice(): boolean {
  try {
    return localStorage.getItem(STT_ENGINE_KEY) !== "false";
  } catch {
    // Storage can be unavailable in private mode. Not worth failing over.
    return true;
  }
}

/**
 * The one session for this page. Module scope rather than component state because there is
 * exactly one per tab and nothing about it belongs to a render: the socket asks it for a token on
 * every connect, and the screens only need to hear when who is signed in changes.
 */
const session = new SessionManager({
  fetch: (input, init) => fetch(input, init),
  storage: browserStore(),
  now: () => Date.now(),
  lock: browserLock(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

// Seeded here, at load, rather than only in App's mount effect: an effect runs AFTER the first
// paint, so a returning visitor's first frame was the sign in form while their stored session was
// still unread. With a stored refresh token this reads "restoring", which renders the start page.
useStore.getState().setSession(session.state());

/** The signed in account's stored dialect, loaded on sign in and saved when the picker moves. */
const preferenceSync = new PreferenceSync((path, init) => session.authorizedFetch(path, init));

/** An account's saved corrections, listed on the start page with a delete, each pinned to its account. */
const savedCorrectionsFor = savedCorrectionsRegistry(session);

/**
 * Mint an invite as the owner. The server checks ownership; this only asks.
 * Null for any refusal, which the landing page turns into one sentence.
 */
async function createInvite(): Promise<string | null> {
  const response = await session.authorizedFetch("/api/invites", { method: "POST" });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

export function App() {
  const store = useStore();
  // Mirror the session into the store, restore a stored one, and ask the server whether signing
  // up needs an invite. Once, on mount.
  useEffect(() => {
    useStore.getState().setSession(session.state());
    const unsubscribe = session.subscribe((state) => useStore.getState().setSession(state));
    void session.restore();

    let cancelled = false;
    void fetch("/healthz")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled || typeof body !== "object" || body === null) return;
        const mode = (body as { signup?: unknown }).signup;
        // Only a value it knows moves it. Anything else leaves the cautious default ("invite").
        if (mode === "invite" || mode === "open") useStore.getState().setSignupMode(mode);
      })
      .catch(() => {
        // Unreachable server. The default already shows the invite field, which is the safe
        // reading, and nothing on this page works without a server anyway.
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  // Stored dialect preference. On sign in, the pre join picker defaults from it, but only while
  // no call is under way: a reload mid call resumes into the dialect the call already has. After
  // that, every change of the picker (before or during a call) is saved.
  const signedInAs = store.session.status === "signedIn" ? store.session.user?.id ?? null : null;
  useEffect(() => {
    preferenceSync.reset();
    if (signedInAs === null) return;
    let cancelled = false;
    void preferenceSync.load().then((prefs) => {
      if (cancelled || !prefs?.dialect) return;
      const { phase: now } = useStore.getState();
      if (now === "landing" || now === "prejoin") useStore.getState().setUiDialect(prefs.dialect);
    });
    return () => {
      cancelled = true;
    };
  }, [signedInAs]);
  useEffect(() => {
    if (signedInAs !== null) void preferenceSync.changed(store.uiDialect);
  }, [signedInAs, store.uiDialect]);

  const copy = useCopy();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [interimText, setInterimText] = useState("");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  /** Set when acquiring a camera mid call failed, most often the permission prompt being denied. */
  const [cameraError, setCameraError] = useState<CopyRef | null>(null);

  const socket = useRef<SignalingSocket | null>(null);
  const peer = useRef<PeerConnection | null>(null);
  const stt = useRef<WebSpeechAdapter | null>(null);
  // A ref, not state: the adapter is built inside a callback, and a stale closure there would
  // silently start the wrong engine.
  const preferOnDevice = useRef(loadPreferOnDevice());
  const meter = useRef<LevelMeter | null>(null);
  const seq = useRef(0);
  /**
   * The local stream, mirrored into a ref.
   *
   * onMessage is a useCallback, so it captures whatever localStream was at the render that
   * created it. room.created arrives milliseconds after setLocalStream, before React has
   * re-rendered, so the handler would read null and silently never start WebRTC. The call would
   * connect, the transcript would work, and no video would ever appear, which is a maddening
   * bug to chase from the symptom. The ref is always current.
   */
  const localStreamRef = useRef<MediaStream | null>(null);
  /** Kept so a failed resume can retry as a fresh join without re-prompting for a name. */
  const rejoinAs = useRef<{ username: string; dialect: string } | null>(null);
  /** Guards the resume fallback, so a genuinely missing room cannot become a retry loop. */
  const retriedJoin = useRef(false);
  /** Guards against a second camera acquisition starting while the first is still awaiting the
   * permission prompt, which would otherwise add two video tracks for one click. */
  const acquiringCamera = useRef(false);

  // A /r/<code> link lands straight on the join form with the code filled in.
  useEffect(() => {
    const fromLink = codeFromPath(location.pathname);
    if (fromLink) {
      store.setPendingCode(fromLink);
      setMode("join");
      store.setPhase("prejoin");
    }
    // Intentionally once on mount: this reads the URL the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const teardown = useCallback(() => {
    stt.current?.stop();
    stt.current = null;
    meter.current?.close();
    meter.current = null;
    peer.current?.close();
    peer.current = null;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setInterimText("");
    setCameraError(null);
  }, []);

  /**
   * The session ended while entering or sitting in a room. Media is released and the person lands
   * on the sign in screen with the reason, rather than on a room that can never reconnect. When
   * the call ended because another tab moved this one to a different account, the tab is still
   * signed in, and the reason says so instead.
   */
  const signedOutOfCall = useCallback(
    (moved = false) => {
      socket.current?.close();
      teardown();
      useStore.getState().reset();
      useStore.getState().setError({ key: moved ? "error.ACCOUNT_CHANGED" : "error.UNAUTHENTICATED" });
    },
    [teardown],
  );

  /** Bring up WebRTC once we know our negotiation role and have media. */
  const startPeer = useCallback(
    (stream: MediaStream, polite: boolean, iceServers: RTCIceServer[]) => {
      if (peer.current) return;

      const connection = new PeerConnection(polite, iceServers, {
        onSignal: ({ kind, payload }) => {
          if (kind === "offer") socket.current?.send({ t: "rtc.offer", sdp: String(payload) });
          else if (kind === "answer") socket.current?.send({ t: "rtc.answer", sdp: String(payload) });
          else socket.current?.send({ t: "rtc.ice", candidate: payload });
        },
        onRemoteStream: (incoming) => setRemoteStream(incoming),
        onStateChange: (state) => useStore.getState().setPeerState(state),
      });

      connection.addLocalStream(stream);
      peer.current = connection;
    },
    [],
  );

  const onMessage = useCallback(
    (message: ServerMessage) => {
      const state = useStore.getState();
      state.apply(message);

      switch (message.t) {
        case "room.created":
        case "room.joined": {
          // A resume arrives as room.joined and REPLACES the transcript with the server's
          // snapshot, which already contains everything the peer finalized while we were gone.
          // Any interim we were holding is a fragment of a sentence that finished without us, so
          // it is older than the snapshot rather than newer, which is the one assumption the
          // subtitle overlay makes about an interim. Left standing it inverts that: the overlay
          // hides the newest settled caption in favour of a pre drop fragment, and holds its fade
          // timer open, so the top row stays empty until the peer happens to speak again.
          setInterimText("");

          // Nothing to import any more: "Load corrections from a past chat" is gone with the
          // transcript download, and the server merges the account's saved corrections into the
          // room itself. glossary.import stays in the protocol (owner decision C6).
          // Tell the room what our mic and camera are actually doing. The server defaults a new
          // member to camera off, and only this side knows the truth, so the peer would otherwise
          // see a placeholder for someone who is on camera. Covers resume too, since a resume
          // arrives as room.joined.
          //
          // wantsTranslation is deliberately NOT asserted here. The server owns that preference
          // and there is no local persistence, so sending our fresh default after a reload would
          // silently switch translation back on and start spending again.
          const media = useStore.getState();
          socket.current?.send({
            t: "member.update",
            micEnabled: media.micEnabled,
            cameraEnabled: media.cameraEnabled,
          });

          // Do NOT negotiate into an empty room.
          //
          // The creator is alone when room.created arrives. Building the peer connection here
          // adds tracks, which fires negotiationneeded, which sends an offer the server relays
          // to nobody. The offer is not merely wasted: it leaves this side sitting in
          // have-local-offer forever. When the other person finally joins and sends a real
          // offer, the impolite peer reads its own stale outstanding offer as a collision and
          // ignores theirs, while the polite peer waits for an answer that is never coming.
          // Both ends deadlock in have-local-offer and no media EVER flows, in either
          // direction, for the whole call.
          //
          // Nothing recovers from it either, because ICE never starts without a remote
          // description, so the disconnect and restart paths are never reached.
          //
          // Negotiation belongs where a peer actually exists: peer.joined for the creator, and
          // right here for a joiner who found someone already in the room.
          const peerPresent = message.t === "room.joined" && message.peer !== null;
          const stream = localStreamRef.current;
          if (stream && peerPresent) startPeer(stream, message.polite, message.iceServers);
          return;
        }

        case "peer.joined": {
          // The impolite side initiates. Adding tracks already fired negotiationneeded, so
          // this only needs to ensure the connection exists.
          const stream = localStreamRef.current;
          if (stream && !peer.current) {
            startPeer(stream, useStore.getState().polite, useStore.getState().iceServers);
          }
          return;
        }

        case "peer.left": {
          // The peer connection belongs to the person who just left, not to the room.
          //
          // Without this it survives them, and startPeer's `if (peer.current) return` guard then
          // makes the next arrival reuse it: their tracks are appended to a remoteStream that
          // still holds the departed peer's ended ones, and the <video> binds to the first video
          // track, which is the dead one. The symptom is a frozen frame of someone who left.
          //
          // Local media and speech recognition deliberately survive. The seat reopens, this
          // person is still in the room, and tearing their own camera down to clean up after
          // someone else's departure would be the wrong scope.
          peer.current?.close();
          peer.current = null;
          setRemoteStream(null);
          // The interim is the PEER's half finished sentence, so it left with them. Nothing else
          // clears it: the clear on transcript.final needs a final that is never coming now.
          // Stranded, it reads as someone still talking who is not even here, and it takes the
          // subtitle overlay's top row with it, because a live interim tells that overlay the
          // settled caption beside it belongs to an older sentence and must not be shown.
          setInterimText("");
          return;
        }

        case "rtc.offer":
          void peer.current?.handleOffer(message.sdp);
          return;
        case "rtc.answer":
          void peer.current?.handleAnswer(message.sdp);
          return;
        case "rtc.ice":
          void peer.current?.handleIce(message.candidate);
          return;

        case "transcript.interim":
          setInterimText(message.text);
          return;
        case "transcript.final":
          // The peer finished a sentence, so the live line is spent.
          if (message.line.from !== useStore.getState().selfId) setInterimText("");
          return;

        case "room.ended":
          teardown();
          return;

        case "error":
          // Only reachable if a socket got in without an account, which the upgrade refuses. Said
          // the same way as a session that expired mid flow.
          if (message.code === "UNAUTHENTICATED") {
            signedOutOfCall();
            return;
          }
          // A stale resume token must not strand someone outside a room that is still there.
          // It happens routinely: the grace window expired while the tab was closed, or the
          // other person ended and restarted. Drop the token and try as a newcomer, once.
          if (message.code === "INVALID_RESUME" || message.code === "ROOM_NOT_FOUND") {
            const credentials = rejoinAs.current;
            const pending = useStore.getState().pendingCode;
            socket.current?.forgetResume();
            if (credentials && pending && !retriedJoin.current) {
              retriedJoin.current = true;
              useStore.getState().setError(null);
              useStore.getState().setPhase("prejoin");
              socket.current?.send({
                t: "room.join",
                code: pending,
                username: credentials.username,
                dialect: credentials.dialect,
              });
            }
          }
          return;

        default:
          return;
      }
    },
    [startPeer, teardown, signedOutOfCall],
  );

  const connect = useCallback(
    (onOpen: () => void) => {
      // Only ever this call's account's tokens: session.callTokens says why.
      const call = session.callTokens();
      const client = new SignalingSocket(
        socketUrl(),
        {
          onMessage,
          onOpen: () => {
            useStore.getState().setSocketState("connected");
            onOpen();
          },
          onClose: ({ terminal }) => {
            useStore.getState().setSocketState(terminal ? "closed" : "reconnecting");
          },
          onReconnecting: () => useStore.getState().setSocketState("reconnecting"),
          // The session is gone (signed out in another tab, or the refresh token was revoked), so
          // no socket can be opened. Back to the start, where the sign in screen says why.
          onSignedOut: () => signedOutOfCall(call.moved()),
        },
        // Asked before EVERY connect, reconnects included, so a call that outlives one access
        // token reconnects with the next. The token rides as a subprotocol, never in the URL.
        call.source,
      );
      socket.current = client;
      client.connect();
    },
    [onMessage, signedOutOfCall],
  );

  /** Acquire media, wire the level meter and speech, then create or join. */
  const enterRoom = useCallback(
    async (input: {
      username: string;
      dialect: string;
      wantsVideo: boolean;
    }) => {
      const media = await acquireMedia(input.wantsVideo);
      if ("kind" in media) {
        useStore.getState().setError(media.notice);
        return;
      }

      localStreamRef.current = media.stream;
      setLocalStream(media.stream);
      useStore.getState().setMedia({
        hasVideo: media.hasVideo,
        cameraEnabled: media.hasVideo,
        micEnabled: true,
      });

      const audioTrack = media.stream.getAudioTracks()[0] ?? null;

      if (audioTrack) {
        meter.current = new LevelMeter(audioTrack, (rms) =>
          useStore.getState().setMedia({ micLevel: rms }),
        );
      }

      // Speech recognition receives the SAME track WebRTC is sending. That is what makes echo
      // cancellation apply to it: see docs/proposals/vt-0001.md.
      const adapter = new WebSpeechAdapter({
        onInterim: (text) => {
          seq.current += 1;
          socket.current?.send({ t: "stt.interim", text, seq: seq.current });
        },
        onFinal: (text) => {
          seq.current += 1;
          socket.current?.send({ t: "stt.final", text, seq: seq.current });
        },
        onStatus: (status) => useStore.getState().setSttStatus(status),
      }, preferOnDevice.current);
      stt.current = adapter;
      void adapter.start(audioTrack, input.dialect);

      // Remember how to join, so a failed resume can fall back to it without asking again.
      rejoinAs.current = { username: input.username, dialect: input.dialect };

      connect(() => {
        const pending = useStore.getState().pendingCode;
        const stored = SignalingSocket.storedResume();

        // RESUME comes first when we have a token for this room. After a reload the user's own
        // previous connection still holds their seat for the grace window, so a fresh join
        // would be refused as ROOM_FULL by their own ghost. Reclaiming the seat is both the
        // correct behavior and the only thing that makes the grace window useful.
        if (pending && stored && stored.code === pending) {
          socket.current?.adoptResume(stored);
          socket.current?.send({ t: "room.resume", code: pending, resumeToken: stored.token });
          return;
        }

        if (mode === "join" && pending) {
          socket.current?.send({
            t: "room.join",
            code: pending,
            username: input.username,
            dialect: input.dialect,
          });
        } else {
          socket.current?.send({
            t: "room.create",
            username: input.username,
            dialect: input.dialect,
            wantsVideo: input.wantsVideo,
          });
        }
      });
    },
    [connect, mode],
  );

  // Restore a seat after a reload, within the grace window.
  useEffect(() => {
    const stored = SignalingSocket.storedResume();
    if (!stored || useStore.getState().phase !== "landing") return;
    // Only prefill; the user still passes through prejoin so media permission is requested in
    // response to a click rather than on page load, which browsers increasingly require.
    useStore.getState().setPendingCode(stored.code);
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  const leave = useCallback(() => {
    // Read BEFORE teardown, which clears `me`. The notice differs because the OUTCOME differs:
    // a guest leaving frees a seat and the room stays open, the host leaving ends the call.
    // Telling everyone the room stays open would be a promise the server no longer keeps.
    const hosting = useStore.getState().me?.isHost === true;
    socket.current?.send({ t: "room.leave" });
    socket.current?.close();
    teardown();
    useStore.getState().setEnded({
      reason: "left",
      notice: { key: hosting ? "app.ended.left.host" : "app.ended.left" },
    });
  }, [teardown]);

  const end = useCallback(() => {
    socket.current?.send({ t: "room.end" });
    teardown();
  }, [teardown]);

  /**
   * Push a change to our own member record and mirror it locally.
   *
   * The local mirror is needed because the server broadcasts peer.updated to everyone EXCEPT the
   * sender, so without it a button driven by `me` would not move until something else happened.
   */
  const announce = useCallback(
    (patch: { micEnabled?: boolean; cameraEnabled?: boolean; wantsTranslation?: boolean }) => {
      socket.current?.send({ t: "member.update", ...patch });
      useStore.setState((s) => (s.me ? { me: { ...s.me, ...patch } } : {}));
    },
    [],
  );

  const toggleMic = useCallback(
    (enabled: boolean) => {
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
      useStore.getState().setMedia({ micEnabled: enabled });
      announce({ micEnabled: enabled });
      // Muting must also pause recognition, or a muted user still gets transcribed and the
      // other person reads a side conversation they were never meant to hear.
      if (enabled) {
        const track = localStream?.getAudioTracks()[0] ?? null;
        void stt.current?.start(track, useStore.getState().me?.dialect ?? "en-US");
      } else {
        stt.current?.stop();
      }
    },
    [localStream, announce],
  );

  const toggleCamera = useCallback(
    (enabled: boolean) => {
      localStream?.getVideoTracks().forEach((track) => {
        track.enabled = enabled;
      });
      useStore.getState().setMedia({ cameraEnabled: enabled });
      announce({ cameraEnabled: enabled });
    },
    [localStream, announce],
  );

  /**
   * Turn a camera on for the first time, for someone who joined audio only.
   *
   * toggleCamera only flips `enabled` on a track that already exists, so it cannot serve this
   * case: an audio only join has no video track at all. This acquires one, adds it to the
   * connection that is already up (addVideoTrack, not addLocalStream, or the existing audio track
   * would be handed to pc.addTrack a second time and rejected), and only then announces
   * cameraEnabled. Announcing before the track exists would tell the peer a camera is live when
   * it is not, which is the exact lie the disabled button used to prevent by never getting here.
   *
   * The await in the middle is a permission prompt, which can stay open indefinitely, so the call
   * can be over by the time it resolves. adoptCameraTrack owns that decision: past it, either
   * there is a live call to publish into or the track has already been stopped.
   */
  const turnOnCamera = useCallback(async () => {
    if (acquiringCamera.current || localStreamRef.current?.getVideoTracks().length) return;
    acquiringCamera.current = true;
    setCameraError(null);

    const result = await acquireCameraTrack();
    acquiringCamera.current = false;

    if ("kind" in result) {
      setCameraError(result.notice);
      return;
    }

    // Nothing below this may run for a call that ended while the prompt was open. Touching the
    // ref would repopulate what teardown just cleared, the store would report a live camera in
    // the ended phase, and announce would push a member.update into a room that is gone.
    const stream = adoptCameraTrack(result.track, {
      phase: useStore.getState().phase,
      stream: localStreamRef.current,
    });
    if (!stream) return;

    // The SAME stream the audio track is already in, so both senders quote one msid and the peer
    // sees one person rather than two. These two lines keep the ref and the state pointing at it
    // rather than driving the repaint: the object did not change identity, so React bails out of
    // the state update. The self view comes back because setMedia flips hasVideo below, which is
    // in that effect's dependencies for exactly this kind of reason.
    localStreamRef.current = stream;
    setLocalStream(stream);

    peer.current?.addVideoTrack(result.track, stream);

    useStore.getState().setMedia({ hasVideo: true, cameraEnabled: true });
    announce({ cameraEnabled: true });
  }, [announce]);

  /**
   * Turn translation on or off FOR YOURSELF.
   *
   * Off means nobody's words get translated for you, which is where the API call is actually
   * saved, and it says nothing about the other direction: your words keep being translated for
   * the other person. Only the server is told; there is no local copy to fall out of sync.
   */
  const toggleTranslation = useCallback(
    (enabled: boolean) => {
      announce({ wantsTranslation: enabled });
    },
    [announce],
  );

  const { phase, pendingCode, error, ended } = store;

  if (phase === "ended" && ended) {
    return (
      <div className="center">
        <div className="card">
          <h1>{copy.t("app.ended.title")}</h1>
          <p className="sub">{copy.ref(ended.notice)}</p>
          <button
            className="primary"
            style={{ width: "100%" }}
            onClick={() => {
              socket.current?.close();
              useStore.getState().reset();
            }}
          >
            {copy.t("app.ended.back")}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "room") {
    return (
      <Room
        localStream={localStream}
        remoteStream={remoteStream}
        interimText={interimText}
        cameraError={cameraError}
        onLeave={leave}
        onEnd={end}
        onToggleMic={toggleMic}
        onToggleCamera={toggleCamera}
        onTurnOnCamera={() => void turnOnCamera()}
        onToggleTranslation={toggleTranslation}
        onChangeDialect={(dialect) => {
          socket.current?.send({ t: "member.update", dialect });
          useStore.setState((s) => (s.me ? { me: { ...s.me, dialect } } : {}));
          // The interface follows the picker, immediately, without waiting for the server to
          // confirm the member update. Owner decision: what you speak is what you read, and a
          // control that changes the language a second later feels like it did not work.
          useStore.getState().setUiDialect(dialect);
          stt.current?.setLanguage(dialect);
        }}
        onCorrect={(lineId, phrase, fix) => socket.current?.send(correctionMessage(lineId, phrase, fix))}
        onRetry={(lineId) => socket.current?.send({ t: "translation.retry", lineId })}
        onSendChat={(text) => socket.current?.send({ t: "chat.send", text })}
        onToggleSttEngine={() => {
          const next = !preferOnDevice.current;
          preferOnDevice.current = next;
          try {
            localStorage.setItem(STT_ENGINE_KEY, String(next));
          } catch {
            // The switch still applies to this call, it just will not survive a reload.
          }
          void stt.current?.setPreferOnDevice(next);
        }}
      />
    );
  }

  // No session: sign in first, whatever screen was coming next. A /r/<code> link keeps its code
  // (phase stays "prejoin"), so signing in lands straight on the join form.
  if (store.session.status === "signedOut") {
    return (
      <AuthScreen
        signupMode={store.signupMode}
        error={error}
        onSignIn={async (email, password) => {
          const outcome = await session.signIn(email, password);
          if (outcome.ok) useStore.getState().setError(null);
          return outcome;
        }}
        onSignUp={async (input) => {
          const outcome = await session.signUp(input);
          if (outcome.ok) useStore.getState().setError(null);
          return outcome;
        }}
      />
    );
  }

  if (phase === "prejoin") {
    return (
      <>
        {error && (
          <div style={{ padding: "16px 16px 0" }}>
            <div className="notice bad" style={{ maxWidth: 440, margin: "0 auto" }}>
              {copy.ref(error)}
            </div>
          </div>
        )}
        <PreJoin
          mode={mode}
          code={pendingCode}
          onCancel={() => {
            useStore.getState().setError(null);
            useStore.getState().setPhase("landing");
          }}
          onReady={(input) => void enterRoom(input)}
        />
      </>
    );
  }

  return (
    <Landing
      initialCode={pendingCode}
      error={error}
      user={store.session.user}
      onSignOut={() => void session.signOut()}
      onCreateInvite={createInvite}
      onDeleteAccount={(password, userId) => session.deleteAccount(password, userId)}
      savedCorrectionsFor={savedCorrectionsFor}
      onCreate={() => {
        setMode("create");
        useStore.getState().setError(null);
        useStore.getState().setPendingCode(null);
        useStore.getState().setPhase("prejoin");
      }}
      onJoin={(code) => {
        setMode("join");
        useStore.getState().setError(null);
        useStore.getState().setPendingCode(code);
        useStore.getState().setPhase("prejoin");
      }}
    />
  );
}
