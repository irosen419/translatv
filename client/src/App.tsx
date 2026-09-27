import { useCallback, useEffect, useRef, useState } from "react";
import type { GlossaryEntry, ServerMessage } from "@translatv/shared";

import { Landing } from "./components/Landing.jsx";
import { PreJoin } from "./components/PreJoin.jsx";
import { Room } from "./components/Room.jsx";
import { codeFromPath } from "./lib/code.js";
import { adoptCameraTrack } from "./rtc/cameraHandoff.js";
import { acquireCameraTrack, acquireMedia, LevelMeter } from "./rtc/media.js";
import { PeerConnection } from "./rtc/PeerConnection.js";
import { SignalingSocket, socketUrl } from "./net/socket.js";
import { useStore } from "./state/store.js";
import { browserStore, clearToken, readToken, writeToken } from "./lib/adminSession.js";
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
 * Trade the password for a token.
 *
 * Resolves false for a refusal and REJECTS for anything that never reached a verdict, so the
 * caller can tell "that password is wrong" from "the server is not answering". Collapsing the
 * two would tell someone their password was wrong during an outage, and they would change it.
 *
 * The password appears in exactly one place, the body of this request. It is never stored,
 * never logged, and never put in the URL where it would reach a proxy access log.
 */
async function adminLogin(password: string): Promise<boolean> {
  const response = await fetch("/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  // 401 is a verdict: that password is wrong. 429 is the absence of one, so it REJECTS and the
  // caller shows "could not reach the server". Reporting a rate limit as a wrong password would
  // tell the owner to change a password that was right.
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`login failed: ${response.status}`);

  const body: unknown = await response.json();
  const token =
    typeof body === "object" && body !== null && typeof (body as { token?: unknown }).token === "string"
      ? (body as { token: string }).token
      : null;
  if (!token) throw new Error("login response carried no token");

  writeToken(browserStore(), token);
  useStore.getState().setAdminToken(token);
  return true;
}

/**
 * The stored admin token, shaped for spreading into a room.create or room.join frame.
 *
 * Read at send time rather than captured once, so logging in or out takes effect on the very
 * next attempt without the component having to re-render first. An empty object when there is
 * no token, which is a guest: the server decides what that means, not this.
 */
function adminTokenField(): { adminToken?: string } {
  const token = readToken(browserStore());
  return token ? { adminToken: token } : {};
}

export function App() {
  const store = useStore();
  // Ask the server whether it gates anything, once. Until it answers the store assumes it does,
  // so the Start button is never live for someone who is about to be refused.
  useEffect(() => {
    let cancelled = false;
    void fetch("/healthz")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled || typeof body !== "object" || body === null) return;
        const required = (body as { adminRequired?: unknown }).adminRequired;
        // Only a real boolean moves it. A server too old to answer this leaves the cautious
        // default in place rather than being read as "no gate".
        if (typeof required === "boolean") useStore.getState().setAdminRequired(required);
      })
      .catch(() => {
        // Unreachable server. The default already says "gated", which is the safe reading, and
        // nothing on this page works without a server anyway.
      });
    return () => {
      cancelled = true;
    };
  }, []);
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
  const pendingGlossary = useRef<GlossaryEntry[]>([]);
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

          // Any glossary the user loaded at the prejoin screen goes up as soon as we have a
          // room to put it in.
          if (pendingGlossary.current.length > 0) {
            socket.current?.send({ t: "glossary.import", entries: pendingGlossary.current });
            pendingGlossary.current = [];
          }
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
          // The server refused an admin action, so whatever token this browser is holding is
          // not good any more: expired, or minted under a password that has since changed.
          // ADMIN_NOT_PRESENT counts, because there is exactly one admin: a token that still
          // worked would have got its bearer in as that admin rather than being told none was
          // there. For a guest, who holds nothing, both calls are no ops.
          // Dropping it here is what keeps the interface honest. Leaving it would show an
          // enabled Start button that fails every time it is pressed, with nothing saying why.
          if (message.code === "ADMIN_REQUIRED" || message.code === "ADMIN_NOT_PRESENT") {
            clearToken(browserStore());
            useStore.getState().setAdminToken(null);
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
                ...adminTokenField(),
              });
            }
          }
          return;

        default:
          return;
      }
    },
    [startPeer, teardown],
  );

  const connect = useCallback(
    (onOpen: () => void) => {
      const client = new SignalingSocket(socketUrl(), {
        onMessage,
        onOpen: () => {
          useStore.getState().setSocketState("connected");
          onOpen();
        },
        onClose: ({ terminal }) => {
          useStore.getState().setSocketState(terminal ? "closed" : "reconnecting");
        },
        onReconnecting: () => useStore.getState().setSocketState("reconnecting"),
      });
      socket.current = client;
      client.connect();
    },
    [onMessage],
  );

  /** Acquire media, wire the level meter and speech, then create or join. */
  const enterRoom = useCallback(
    async (input: {
      username: string;
      dialect: string;
      wantsVideo: boolean;
      glossary: GlossaryEntry[];
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
      pendingGlossary.current = input.glossary;

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
            ...adminTokenField(),
          });
        } else {
          socket.current?.send({
            t: "room.create",
            username: input.username,
            dialect: input.dialect,
            wantsVideo: input.wantsVideo,
            ...adminTokenField(),
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
    // a guest leaving frees a seat and the room stays open, the admin leaving ends the call.
    // Telling everyone the room stays open would be a promise the server no longer keeps.
    const hosting = useStore.getState().me?.isAdmin === true;
    socket.current?.send({ t: "room.leave" });
    socket.current?.close();
    teardown();
    useStore.getState().setEnded({
      reason: "left",
      notice: { key: hosting ? "app.ended.left.admin" : "app.ended.left" },
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
        onCorrect={(lineId, correctedTranslation) =>
          socket.current?.send({ t: "glossary.correct", lineId, correctedTranslation })
        }
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
      adminRequired={store.adminRequired}
      isAdmin={store.adminToken !== null}
      onLogin={adminLogin}
      onLogout={() => {
        clearToken(browserStore());
        // Dropped from memory as well as from storage, deliberately. clearToken swallows a
        // storage that refuses to delete, so trusting it alone would leave someone "logged out"
        // on screen while the next create still sent the old credential.
        useStore.getState().setAdminToken(null);
      }}
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
