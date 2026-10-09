import { useEffect, useMemo, useRef, useState } from "react";
import { DIALECTS, translationNeed } from "@translatv/shared";
import { useStore } from "../state/store.js";
import { SubtitleOverlay } from "./SubtitleOverlay.jsx";
import { TranscriptPanel } from "./TranscriptPanel.jsx";
import { ConversationOverlay } from "./ConversationOverlay.jsx";
import { ControlDrawer } from "./ControlDrawer.jsx";
import { roomLink } from "../lib/code.js";
import { NARROW_QUERY, useMediaQuery } from "../lib/useMediaQuery.js";
import { buildChips, isProblem, type Chip } from "../lib/chips.js";
import { useCopy } from "../i18n/useCopy.js";
import type { Copy, CopyRef } from "../i18n/copy.js";

/** The conventional two overlapping documents. Inline so the app takes no icon dependency. */
function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

/** Shown in place of the copy icon for the couple of seconds after a successful copy. */
function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

interface Props {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  /** The peer's live, unfinalized speech. Not in the store: it changes several times a second. */
  interimText: string;
  /** Set when acquiring a camera mid call failed, most often the permission prompt being denied. */
  cameraError: CopyRef | null;
  onLeave(): void;
  onEnd(): void;
  onToggleMic(enabled: boolean): void;
  onToggleCamera(enabled: boolean): void;
  /** Turn a camera on for the first time, for someone who joined audio only. */
  onTurnOnCamera(): void;
  onToggleTranslation(enabled: boolean): void;
  onChangeDialect(dialect: string): void;
  onCorrect(lineId: string, corrected: string): void;
  onRetry(lineId: string): void;
  onSendChat(text: string): void;
  /** Switch between the on device and cloud recognizers, which trade privacy against accuracy. */
  onToggleSttEngine(): void;
}

export function Room(props: Props) {
  const {
    code,
    selfId,
    me,
    peer,
    lines,
    glossary,
    peerState,
    sttStatus,
    socketState,
    micEnabled,
    cameraEnabled,
    hasVideo,
    micLevel,
    translationUnavailable,
  } = useStore();

  // Everyone in a room is a signed in account now, so the download is offered to both people.
  // It was host only while guests were anonymous, and it was never access control even then: a
  // guest's browser already holds every line, because it needs them to render the subtitles.
  const canExport = true;

  const localVideo = useRef<HTMLVideoElement>(null);
  const remoteVideo = useRef<HTMLVideoElement>(null);
  const [showPanel, setShowPanel] = useState(true);
  // Narrow screens merge subtitles and chat into one overlay over the video. Wide screens keep
  // the side panel, which shows far more of the conversation than a bottom strip can.
  const narrow = useMediaQuery(NARROW_QUERY);
  // Which control was last used, so the two copy buttons confirm independently. A single boolean
  // would light both up at once and leave you unsure which thing is on the clipboard.
  const [copied, setCopied] = useState<"code" | "link" | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const copy = useCopy();

  // Two separate facts, because they answer different questions and only one of them used to be
  // asked. Track presence says whether they have a camera AT ALL. cameraEnabled says whether it
  // is live right now, and it has to come over the wire: turning a camera off only flips
  // track.enabled, which leaves the track in place, so the receiver sees a frozen frame and no
  // amount of inspecting the stream can tell that apart from a working camera.
  //
  // Declared above the effects below because they are in those dependency arrays.
  const remoteVideoTrackPresent = (props.remoteStream?.getVideoTracks().length ?? 0) > 0;
  const peerCameraOn = remoteVideoTrackPresent && Boolean(peer?.cameraEnabled);

  // Both of these depend on the VISIBILITY flags as well as the stream, because both <video>
  // elements are mounted conditionally. Without that, turning a camera off and back on remounts
  // a fresh element whose srcObject is never set, and the video stays black forever with no
  // error anywhere. The self view had this bug already.
  useEffect(() => {
    if (localVideo.current && props.localStream) {
      localVideo.current.srcObject = props.localStream;
    }
  }, [props.localStream, hasVideo, cameraEnabled]);

  useEffect(() => {
    if (remoteVideo.current && props.remoteStream) {
      remoteVideo.current.srcObject = props.remoteStream;
    }
  }, [props.remoteStream, peerCameraOn]);

  /** The peer's most recent finalized line drives the overlay. */
  const peerLine = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (line && line.from !== selfId) return line;
    }
    return null;
  }, [lines, selfId]);

  /**
   * Is the translation toggle meaningful right now?
   *
   * Uses the same shared helper the server decides with, so the button cannot claim one thing
   * while the server does another. Only known once a peer exists: alone in a room nothing is
   * being translated either, but setting the preference before someone arrives is legitimate.
   *
   * Strictly "no". An UNKNOWN pair is not moot: the server refuses those and says so, and
   * greying the toggle out with "you both speak the same language" would be the old silent lie
   * moved onto a button.
   */
  const translationMoot =
    Boolean(me && peer) && translationNeed(me!.dialect, peer!.dialect) === "no";

  const chips = buildChips({
    peerPresent: Boolean(peer),
    peerConnection: peer?.connection ?? null,
    peerState,
    socketState,
    sttStatus,
    peerName: peer?.username ?? null,
    peerMicEnabled: peer?.micEnabled ?? true,
    peerWantsTranslation: peer?.wantsTranslation ?? true,
    translationUnavailable,
    onToggleSttEngine: props.onToggleSttEngine,
  });
  // On a narrow screen only problems earn space over the video; everything else rides down into
  // the drawer with the rest of the header. A wide screen has a top bar and shows the lot.
  const floatingChips = narrow ? chips.filter(isProblem) : [];
  const drawerChips = narrow ? chips.filter((chip) => !isProblem(chip)) : [];

  // Clipboard can be blocked. The code is on screen either way, so these are conveniences and
  // never the only path to sharing a room.
  async function copyToClipboard(what: "code" | "link"): Promise<void> {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(what === "code" ? code : roomLink(code));
      setCopied(what);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      // Nothing to recover: the value is visible in the header.
    }
  }

  const names = (
    <div className="names">
      {me?.username ?? copy.t("room.you")}
      <span className="muted">
        {` ${copy.t("room.and")} `}
        {peer ? peer.username : copy.t("room.waiting")}
      </span>
    </div>
  );

  // One definition, rendered in the top bar on a wide screen and inside the drawer on a narrow
  // one. Two copies would be two places for the copied state to be wired up differently.
  const codeControls = (
    <>
      <span className="code-badge">{code}</span>
      <button
        className={copied === "code" ? "icon-button copied" : "icon-button"}
        onClick={() => void copyToClipboard("code")}
        aria-label={copied === "code" ? copy.t("room.code.copied") : copy.t("room.code.copy")}
        title={copied === "code" ? copy.t("room.copied") : copy.t("room.code.copy")}
      >
        {/* The icon itself carries the confirmation. A title alone says nothing on a touch
            screen, where there is no hover to reveal it. */}
        {copied === "code" ? <CheckIcon /> : <CopyIcon />}
      </button>
      <button
        className={copied === "link" ? "copied" : undefined}
        onClick={() => void copyToClipboard("link")}
        style={{ padding: "5px 10px", fontSize: 12 }}
      >
        {copied === "link" ? copy.t("room.copied") : copy.t("room.link.copy")}
      </button>
    </>
  );

  return (
    <div className="room">
      {/* A narrow screen has no top bar at all. Everything that was in it lives in the drawer, so
          the video keeps the whole screen. */}
      {!narrow && (
        <header className="topbar">
          {names}
          {codeControls}

          <span className="spacer" />

          <Chips chips={chips} />

          <button
            onClick={() => setShowPanel((v) => !v)}
            style={{ padding: "5px 10px", fontSize: 12 }}
          >
            {showPanel ? copy.t("room.transcript.hide") : copy.t("room.transcript.show")}
          </button>
        </header>
      )}

      {/* Three states, not two. The panel is MOUNTED whenever there is room for it, and open or
          closed is a class, because a component that unmounts cannot animate on its way out. */}
      <div
        className={`stage${
          !narrow && code ? (showPanel ? " with-panel" : " with-panel-closed") : ""
        }`}
      >
        <div className="video-area">
          {peerCameraOn ? (
            <video ref={remoteVideo} autoPlay playsInline />
          ) : (
            <div className="placeholder">
              <div className="avatar">{initial(peer?.username)}</div>
              {!peer ? (
                /* Alone in the room, sharing the code is the ONLY thing there is to do, so it is
                   the thing on screen rather than something to go hunting for. The old copy said
                   "the code above", which stopped being true the moment the header moved into a
                   drawer. Once someone joins this whole block is replaced. */
                <div className="invite">
                  <div>{copy.t("room.invite.lead")}</div>
                  <div className="invite-code">{code}</div>
                  <div className="invite-actions">
                    <button onClick={() => void copyToClipboard("code")}>
                      {copied === "code" ? copy.t("room.copied") : copy.t("room.invite.copyCode")}
                    </button>
                    <button onClick={() => void copyToClipboard("link")}>
                      {copied === "link" ? copy.t("room.copied") : copy.t("room.link.copy")}
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  {/* Someone who turned their camera off and someone who never had one look
                      identical from the stream alone, and they are different situations: one is
                      temporary and the other is not worth waiting for. */}
                  {remoteVideoTrackPresent
                    ? copy.t("room.peer.cameraOff", { name: peer.username })
                    : copy.t("room.peer.noCamera", { name: peer.username })}
                </div>
              )}
            </div>
          )}

          {/* Problems only, and only on a narrow screen. A warning you cannot see until you open
              settings is a warning that arrives after you have already given up on the call. */}
          {floatingChips.length > 0 && (
            <div className="alerts">
              <Chips chips={floatingChips} />
            </div>
          )}

          <div className="self-stack">
            <div className="self-view">
              {hasVideo && cameraEnabled ? (
                <video ref={localVideo} autoPlay playsInline muted />
              ) : (
                <div className="placeholder">
                  <div className="avatar">{initial(me?.username)}</div>
                  <div>{copy.t("room.you")}</div>
                </div>
              )}
            </div>

            {/* Mic and camera sit here rather than in the drawer, and that is the one place the
                drawer does not own. Muting has to stay a single tap, and the level meter has to
                stay visible: behind a closed drawer there is no way to see that you are still
                hot. */}
            <div className="self-controls">
              <button
                className={micEnabled ? "self-control" : "self-control off"}
                onClick={() => props.onToggleMic(!micEnabled)}
                aria-label={
                  micEnabled ? copy.t("room.mic.muteLabel") : copy.t("room.mic.unmuteLabel")
                }
                title={micEnabled ? copy.t("room.mic.mute") : copy.t("room.mic.unmute")}
              >
                {micEnabled ? copy.t("room.mic.mute") : copy.t("room.mic.unmute")}
              </button>
              <div className="level" title={copy.t("room.mic.level")}>
                <div style={{ width: `${Math.min(100, micLevel * 400)}%` }} />
              </div>
              <button
                className={cameraEnabled ? "self-control" : "self-control off"}
                onClick={() => (hasVideo ? props.onToggleCamera(!cameraEnabled) : props.onTurnOnCamera())}
                aria-label={
                  cameraEnabled ? copy.t("room.camera.offLabel") : copy.t("room.camera.onLabel")
                }
                title={cameraEnabled ? copy.t("room.camera.off") : copy.t("room.camera.on")}
              >
                {cameraEnabled ? copy.t("room.camera.off") : copy.t("room.camera.on")}
              </button>
            </div>
            {props.cameraError && (
              <div className="notice bad camera-error">{copy.ref(props.cameraError)}</div>
            )}
          </div>

          {narrow ? (
            <ConversationOverlay
              lines={lines}
              selfId={selfId}
              interimText={props.interimText}
              viewerDialect={me?.dialect ?? null}
              onSendChat={props.onSendChat}
            />
          ) : (
            <SubtitleOverlay
              line={peerLine}
              interimText={props.interimText}
              viewerDialect={me?.dialect ?? null}
            />
          )}
        </div>

        {!narrow && code && (
          <TranscriptPanel
            lines={lines}
            glossary={glossary}
            selfId={selfId}
            me={me}
            peer={peer}
            roomCode={code}
            canExport={canExport}
            onCorrect={props.onCorrect}
            onRetry={props.onRetry}
            onSendChat={props.onSendChat}
          />
        )}
      </div>

      <ControlDrawer>
        {/* The whole room header, on the screens that no longer have one. */}
        {narrow && (
          <>
            {names}
            {codeControls}
            {drawerChips.length > 0 && <Chips chips={drawerChips} />}
          </>
        )}

        <select
          value={me?.dialect ?? "en-US"}
          onChange={(event) => props.onChangeDialect(event.target.value)}
          style={{ width: "auto", flex: "0 0 auto" }}
          aria-label={copy.t("room.dialect.label")}
          title={copy.t("room.dialect.title")}
        >
          {DIALECTS.map((d) => (
            <option key={d.code} value={d.code}>
              {d.label}
            </option>
          ))}
        </select>

        {/* Disabled rather than hidden when it would do nothing. The dialect picker is right
            there and either side can change language mid call, so a control that appeared and
            vanished would be worse than one that explains itself. */}
        <button
          onClick={() => props.onToggleTranslation(!(me?.wantsTranslation ?? true))}
          disabled={translationMoot}
          className={
            translationMoot ? "" : (me?.wantsTranslation ?? true) ? "toggle-on" : "toggle-off"
          }
          title={
            translationMoot
              ? copy.t("room.translation.mootTitle")
              : copy.t("room.translation.title")
          }
        >
          {/* The label is the CURRENT STATE, not the action. It used to be the action ("Translation
              off" while translation was ON), which sat next to a speech chip labelled with its
              state, so two adjacent controls read by opposite conventions and neither said which
              it was. Owner report: "I can't tell if these are indicators of current status or
              what would happen if I press the button." State is the safer of the two, because a
              label that names the action is only legible to someone who already knows the
              state. */}
          {translationMoot ? (
            copy.t("room.translation.moot")
          ) : (
            <>
              {copy.t("room.translation.lead")}{" "}
              {(me?.wantsTranslation ?? true) ? (
                <span className="state-on">{copy.t("room.translation.on")}</span>
              ) : (
                <span className="state-off">{copy.t("room.translation.off")}</span>
              )}
            </>
          )}
        </button>

        {/* No "you said" chip here. It existed when your own words appeared nowhere else on
            screen; the conversation overlay now labels them, so a chip repeating the newest one
            was showing the same sentence twice in two places. */}
        <button onClick={props.onLeave}>{copy.t("room.leave")}</button>
        <button className="danger" onClick={() => setConfirmEnd(true)}>
          {copy.t("room.end")}
        </button>
      </ControlDrawer>

      {confirmEnd && (
        <EndDialog
          copy={copy}
          isHost={me?.isHost === true}
          onCancel={() => setConfirmEnd(false)}
          onConfirm={() => {
            setConfirmEnd(false);
            props.onEnd();
          }}
        />
      )}
    </div>
  );
}

/**
 * Render a list of chips.
 *
 * The deciding of WHICH chips exist lives in lib/chips.ts, because two different places on screen
 * now show different subsets of them and that split has to be testable without a DOM.
 */
function Chips({ chips }: { chips: Chip[] }) {
  const copy = useCopy();
  return (
    <>
      {chips.map((chip) =>
        chip.onClick ? (
          <button
            key={chip.text}
            className={`chip ${chip.tone} chip-button`}
            title={copy.ref(chip.title)}
            onClick={chip.onClick}
          >
            {copy.t(chip.text)}
          </button>
        ) : (
          <span key={chip.text} className={`chip ${chip.tone}`} title={copy.ref(chip.title)}>
            {copy.t(chip.text)}
          </span>
        ),
      )}
    </>
  );
}

function EndDialog({
  copy,
  isHost,
  onCancel,
  onConfirm,
}: {
  copy: Copy;
  /** You are the host, so leaving ends this call rather than freeing a seat. */
  isHost: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);

  return (
    <dialog ref={ref} onClose={onCancel}>
      <h2>{copy.t("room.end.title")}</h2>
      <p>{copy.t("room.end.body")}</p>
      {/* The alternative only EXISTS for a guest. Leaving keeps the room open for the other
          person, which is exactly what it says, unless you are the one hosting: then leaving
          ends the call and offering it as a gentler option would be a straight lie about what
          the button does. The host gets told that instead. */}
      {isHost ? (
        <p>{copy.t("room.end.host.note")}</p>
      ) : (
        <p>
          {/* Split either side of the button name rather than interpolated, because the emphasis
              has to survive and a placeholder can only carry a string, not a strong element. Two
              keys let each language put the clause where its own word order wants it. */}
          {copy.t("room.end.alt.before")} <strong>{copy.t("room.leave")}</strong>{" "}
          {copy.t("room.end.alt.after")}
        </p>
      )}
      <div className="row">
        <button type="button" onClick={() => ref.current?.close()} style={{ flex: "0 0 auto" }}>
          {copy.t("room.end.cancel")}
        </button>
        <button type="button" className="danger" onClick={onConfirm}>
          {copy.t("room.end.confirm")}
        </button>
      </div>
    </dialog>
  );
}

function initial(name: string | undefined): string {
  return (name ?? "?").trim().charAt(0).toUpperCase() || "?";
}
