import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { DIALECTS, translationNeed, type ClientMessage } from "@translatv/shared";
import { useStore } from "../state/store.js";
import { SubtitleOverlay } from "./SubtitleOverlay.jsx";
import { TranscriptPanel } from "./TranscriptPanel.jsx";
import { ConversationOverlay } from "./ConversationOverlay.jsx";
import { ControlDrawer } from "./ControlDrawer.jsx";
import { SelectShell } from "./SelectShell.jsx";
import { ThemePickerView } from "./ThemePicker.jsx";
import { SafetyDialog, type SafetyActions } from "./SafetyDialog.jsx";
import { peerLinesFor } from "../lib/caption.js";
import { roomLink } from "../lib/code.js";
import { NARROW_QUERY, useMediaQuery } from "../lib/useMediaQuery.js";
import { buildChips, isProblem, sttAlert, type Chip, type SttAlert } from "../lib/chips.js";
import { useCopy } from "../i18n/useCopy.js";
import { useTheme, useVideoWellStyle } from "../theme/useTheme.js";
import type { ThemeChoice } from "../theme/theme.js";
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

/*
 * The four self view icons: a microphone and a camera, each with a crossed out twin.
 *
 * Same house style as the two above and as the gear in ControlDrawer: a 24 unit viewBox, no
 * fill, currentColor strokes, drawn here rather than pulled from a library so the app still
 * takes no icon dependency. They differ from those two in being a FAMILY rather than one offs,
 * so they are one component over a table of strokes instead of four copies of the same svg.
 * That is not only less to read: it makes "the crossed out one is the plain one plus a diagonal"
 * true by construction rather than true until somebody edits one of the pair. The pair differing
 * by exactly the stroke that carries the meaning is what makes them legible at 14px on a phone.
 *
 * Everything is a path, including the shapes that would read more naturally as a rect, because a
 * single list of strokes is what lets the crossed out variants be built by appending to it.
 *
 * They are drawn at 14px, matching the copy icons, inside a 26px button. That is deliberately
 * close to the 11px text control these replaced: the old label stood about 16px tall in its box,
 * so the row keeps the height it had and nothing above or below it moves.
 */

/** The microphone capsule, its cradle, and the stand under it. */
const MIC_STROKES = [
  "M12 2a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z",
  "M19 11v1a7 7 0 0 1-14 0v-1",
  "M12 19v3",
  "M8 22h8",
];

/** The camera body and the lens wedge off its side. */
const CAMERA_STROKES = [
  "M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
  "M22 8v8l-7-4z",
];

/** The one stroke that turns any of these into its own negation. */
const CROSSED_OUT_STROKE = "M3 3 21 21";

export type SelfControlIconName = "mic" | "mic-off" | "camera" | "camera-off";

const SELF_CONTROL_ICON_STROKES: Record<SelfControlIconName, string[]> = {
  mic: MIC_STROKES,
  "mic-off": [...MIC_STROKES, CROSSED_OUT_STROKE],
  camera: CAMERA_STROKES,
  "camera-off": [...CAMERA_STROKES, CROSSED_OUT_STROKE],
};

/**
 * One self view icon.
 *
 * `data-icon` is not decoration. It is the stable name the node suite asserts on, so a test can
 * say WHICH icon was drawn without reading path geometry, which moves whenever somebody nudges a
 * curve. A guard that fails on a cosmetic edit teaches people to edit the guard.
 */
function SelfControlIcon({ name }: { name: SelfControlIconName }): ReactElement {
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
      data-icon={name}
    >
      {SELF_CONTROL_ICON_STROKES[name].map((stroke) => (
        <path key={stroke} d={stroke} />
      ))}
    </svg>
  );
}

/** Which device a self view toggle controls. Each one has a live icon and a stopped one. */
export type SelfControlDevice = "mic" | "camera";

const SELF_CONTROL_ICONS: Record<
  SelfControlDevice,
  { live: SelfControlIconName; stopped: SelfControlIconName }
> = {
  mic: { live: "mic", stopped: "mic-off" },
  camera: { live: "camera", stopped: "camera-off" },
};

/**
 * The speech failure notice, as a plain function so the node suite can call it.
 *
 * Hook free on purpose, the same way SelfControlButton is: the decision of WHETHER to show this
 * lives in lib/chips.ts and is tested there, and what it renders is tested by calling this.
 * What neither can see is a browser painting it, which is why the sizing was measured rather
 * than reasoned about.
 */
export interface SttAlertNoticeProps {
  alert: SttAlert;
  copy: Copy;
  onDismiss(): void;
}

export function SttAlertNotice({ alert, copy, onDismiss }: SttAlertNoticeProps): ReactElement {
  return (
    <div className="notice bad stt-alert" role="alert">
      <div className="stt-alert-text">
        <strong>{copy.t(alert.title)}</strong>
        <span>{copy.t(alert.body)}</span>
        {/* The adapter's own instructions. Rendered as a copy REF, so the fix for a denied
            permission arrives in the reader's language without this component knowing which
            failure it is looking at. */}
        <span className="stt-alert-fix">{copy.ref(alert.notice)}</span>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={onDismiss}
        aria-label={copy.t("alert.dismiss")}
        title={copy.t("alert.dismiss")}
      >
        &times;
      </button>
    </div>
  );
}

export interface SelfControlButtonProps {
  device: SelfControlDevice;
  /** Is the device live right now? Drives the icon and the danger colouring, nothing else. */
  live: boolean;
  /** What pressing this will DO, already resolved in the reader's dialect. */
  actionLabel: string;
  onClick(): void;
}

/**
 * One self view toggle: the microphone or the camera, icon only.
 *
 * THE ICON AND THE ACCESSIBLE NAME DELIBERATELY DISAGREE, and neither is the other's mistake.
 *
 * The icon reports the STATE. A crossed out microphone means "you are muted" in Zoom, Meet and
 * Teams, and it is what people arrive already knowing; a picture cannot say "press me to mute"
 * without inventing a vocabulary nobody has learned. The name reports the ACTION. A screen
 * reader announces the control you are about to activate, so "Mute your microphone" tells the
 * listener what happens next, where "microphone, live" would leave them to work it out. The
 * title carries the same action string as the name, so a sighted mouse user can discover the
 * icon and the two can never drift into describing the button differently.
 *
 * Note this INVERTS the visible labels these buttons used to carry, which named the action
 * ("Mute" while you were live). Room.test.ts pins both halves so the disagreement cannot be
 * quietly tidied away by somebody who reads it as a bug.
 *
 * Copy comes in already resolved rather than being looked up here, which keeps this hook free
 * and therefore callable as a plain function by the node suite, the same way lib/chips.ts keeps
 * the chip decision testable without a DOM.
 */
export function SelfControlButton({
  device,
  live,
  actionLabel,
  onClick,
}: SelfControlButtonProps): ReactElement {
  const icons = SELF_CONTROL_ICONS[device];
  return (
    <button
      className={live ? "self-control" : "self-control off"}
      onClick={onClick}
      aria-label={actionLabel}
      title={actionLabel}
    >
      <SelfControlIcon name={live ? icons.live : icons.stopped} />
    </button>
  );
}

/** The language group: which dialect you speak, and whether the other person gets translated. */
interface LanguageGroup {
  dialect: string;
  onChangeDialect(dialect: string): void;
  translationOn: boolean;
  /**
   * Would translating do nothing? True once both people are known to share a language, which
   * is the server's own answer rather than a second opinion computed here.
   */
  translationMoot: boolean;
  onToggleTranslation(): void;
}

/** The theme group: the chosen palette and appearance, and the one way to change either. */
interface ThemeGroup {
  choice: ThemeChoice;
  onChoose(change: Partial<ThemeChoice>): void;
}

/** The chat controls group: the two ways out of the room, and nothing else. */
interface ChatControlsGroup {
  onLeave(): void;
  onEnd(): void;
  /**
   * Report or block the other person. Absent with nobody there to report, or nothing to name them
   * by (no contactId), and then the entry is not drawn at all.
   */
  onReport?(): void;
}

export interface DrawerContentsProps {
  copy: Copy;
  /**
   * The room header, on the narrow screens that have no top bar to hold it. Null on a wide
   * screen, where .topbar still does. It is NOT a fourth group: it is the names, the code and
   * the chips, so it gets a full width row of its own above the bar.
   */
  header: ReactNode;
  language: LanguageGroup;
  theme: ThemeGroup;
  chat: ChatControlsGroup;
}

/**
 * Everything inside the settings drawer: one inline bar of three groups, in one order.
 *
 * LANGUAGE, THEME, CHAT CONTROLS, spread across the drawer with space-between. Owner decision,
 * and the grouping is the point rather than the spacing: the dialect picker and the translation
 * toggle are both about language, so they travel together, and Leave and End chat are the whole
 * of the third group. The props are shaped as those same three groups, so a control added later
 * has to be put in one of them rather than dropped into a flat list of eleven props.
 *
 * The groups are the bar's only children. A group is its own flex container, so the bar's wrap
 * can only ever move a WHOLE group onto the next line, and a group that runs out of room stacks
 * its own controls instead of splitting. Neither of those is visible from here: styles.css
 * carries them and styles.test.ts pins them. What this function owns is the structure, which
 * Room.test.ts reads back without a renderer.
 *
 * Hook free on purpose, like SelfControlButton and ThemePickerView above it. Copy, the theme
 * and every handler arrive as arguments, which is what makes the whole drawer callable as an
 * ordinary function in the node suite.
 */
export function DrawerContents({ copy, header, language, theme, chat }: DrawerContentsProps) {
  return (
    <>
      {header ? <div className="drawer-header">{header}</div> : null}

      <div className="settings-bar">
        <div className="settings-group">
          {/* The shell is what draws the chevron. Every select in the app lost the browser's
              own arrow to `appearance: none`, so one outside a shell reads as a text box that
              cannot be typed in. */}
          <SelectShell>
            <select
              className="dialect-select"
              value={language.dialect}
              onChange={(event) => language.onChangeDialect(event.target.value)}
              aria-label={copy.t("room.dialect.label")}
              title={copy.t("room.dialect.title")}
            >
              {DIALECTS.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.label}
                </option>
              ))}
            </select>
          </SelectShell>

          {/* Disabled rather than hidden when it would do nothing. The dialect picker is right
              there and either side can change language mid call, so a control that appeared and
              vanished would be worse than one that explains itself. */}
          <button
            onClick={language.onToggleTranslation}
            disabled={language.translationMoot}
            className={
              language.translationMoot ? "" : language.translationOn ? "toggle-on" : "toggle-off"
            }
            title={
              language.translationMoot
                ? copy.t("room.translation.mootTitle")
                : copy.t("room.translation.title")
            }
          >
            {/* The label is the CURRENT STATE, not the action. It used to be the action
                ("Translation off" while translation was ON), which sat next to a speech chip
                labelled with its state, so two adjacent controls read by opposite conventions
                and neither said which it was. Owner report: "I can't tell if these are
                indicators of current status or what would happen if I press the button." State
                is the safer of the two, because a label that names the action is only legible
                to someone who already knows the state. */}
            {language.translationMoot ? (
              copy.t("room.translation.moot")
            ) : (
              <>
                {copy.t("room.translation.lead")}{" "}
                {language.translationOn ? (
                  <span className="state-on">{copy.t("room.translation.on")}</span>
                ) : (
                  <span className="state-off">{copy.t("room.translation.off")}</span>
                )}
              </>
            )}
          </button>
        </div>

        <ThemePickerView theme={theme.choice} copy={copy} onChoose={theme.onChoose} />

        {/* Last, because Leave and End chat should stay the last things a thumb lands on, and
            because the two ways out are the one pair in here nobody is in a hurry to reach.

            No "you said" chip beside them. It existed when your own words appeared nowhere else
            on screen; the conversation overlay now labels them, so a chip repeating the newest
            one was showing the same sentence twice in two places. */}
        <div className="settings-group">
          {chat.onReport ? <button onClick={chat.onReport}>{copy.t("safety.open")}</button> : null}
          <button onClick={chat.onLeave}>{copy.t("room.leave")}</button>
          <button className="danger" onClick={chat.onEnd}>
            {copy.t("room.end")}
          </button>
        </div>
      </div>
    </>
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
  /** A term level correction: a phrase from the line, and its fix. */
  onCorrect(message: Extract<ClientMessage, { t: "glossary.correct" }>): void;
  onRetry(lineId: string): void;
  onSendChat(text: string): void;
  /** Switch between the on device and cloud recognizers, which trade privacy against accuracy. */
  onToggleSttEngine(): void;
  /** Reporting and blocking, as the signed in account. Null when nobody is signed in. */
  safety: SafetyActions | null;
  /** A block from inside the call landed, so the call is over: the name is the one on screen. */
  onBlockedInCall(name: string): void;
}

export function Room(props: Props) {
  const {
    code,
    selfId,
    me,
    peer,
    lines,
    peerState,
    sttStatus,
    socketState,
    micEnabled,
    cameraEnabled,
    hasVideo,
    micLevel,
    translationUnavailable,
    peerContactId,
  } = useStore();

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
  /** Who the report or block dialog is open for, fixed when it opened. */
  const [reporting, setReporting] = useState<{ contactId: string; name: string } | null>(null);
  const [dismissedAlert, setDismissedAlert] = useState<string | null>(null);
  const copy = useCopy();
  const wellStyle = useVideoWellStyle();
  // Read here rather than inside the picker, so the whole drawer stays a hook free view that
  // the node suite can call. One reader, and it is the component that owns the drawer.
  const { theme, choose: chooseTheme } = useTheme();

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

  /** The peer's newest line, and the newest one with a translation settled, drive the overlay. */
  const peerLines = useMemo(() => peerLinesFor(lines, selfId), [lines, selfId]);

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

  /** Translation is on unless you turned it off, including before the server has told us. */
  const translationOn = me?.wantsTranslation ?? true;

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

  /**
   * The one failure that needs a sentence rather than a chip.
   *
   * Dismissible, and dismissed per FAILURE rather than once for the session: the key is the
   * status kind, so a later, different failure speaks up again instead of inheriting a dismissal
   * of the first. Closing it is meant to say "I have read this", not "never tell me again".
   */
  const alert = sttAlert({ sttStatus });
  const alertKey = alert ? sttStatus.kind : null;
  const showAlert = alert !== null && dismissedAlert !== alertKey;

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
        {/* The well carries the theme's DARK palette as inline custom properties, whatever the
            page is painted in, and every descendant inherits them: the placeholder, the avatar,
            the alert chips, the self view and both subtitle overlays. The well is dark in every
            theme, so the things drawn on it have to be the dark half's, and doing it here rather
            than rule by rule is what keeps that true for anything added inside later. */}
        <div className="video-area" style={wellStyle}>
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

          {/* The speech failure, spelled out, over the video where the call is.
              
              Not a tooltip. The previous version of this put the whole explanation in a `title`
              on a two word pill, which a phone never shows, so somebody spoke an entire call
              believing they were being subtitled. role="alert" so a screen reader is told too,
              rather than this being one more thing only a sighted user learns. */}
          {/* One stack, because both of these are pinned to the top left of the well and two
              absolutely positioned boxes at the same coordinates sit ON each other. The alert's
              height depends on how long the translation runs, so no fixed offset on the chips
              could have been right; a flex column just asks the layout. */}
          {(showAlert || floatingChips.length > 0) && (
          <div className="well-alerts">
          {showAlert && alert && (
            <SttAlertNotice alert={alert} copy={copy} onDismiss={() => setDismissedAlert(alertKey)} />
          )}

          {/* Problems only, and only on a narrow screen. A warning you cannot see until you open
              settings is a warning that arrives after you have already given up on the call. */}
          {floatingChips.length > 0 && (
            <div className="alerts">
              <Chips chips={floatingChips} />
            </div>
          )}
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
              <SelfControlButton
                device="mic"
                live={micEnabled}
                actionLabel={
                  micEnabled ? copy.t("room.mic.muteLabel") : copy.t("room.mic.unmuteLabel")
                }
                onClick={() => props.onToggleMic(!micEnabled)}
              />
              <div className="level" title={copy.t("room.mic.level")}>
                <div style={{ width: `${Math.min(100, micLevel * 400)}%` }} />
              </div>
              <SelfControlButton
                device="camera"
                live={cameraEnabled}
                actionLabel={
                  cameraEnabled ? copy.t("room.camera.offLabel") : copy.t("room.camera.onLabel")
                }
                onClick={() =>
                  hasVideo ? props.onToggleCamera(!cameraEnabled) : props.onTurnOnCamera()
                }
              />
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
              peer={peerLines}
              interimText={props.interimText}
              viewerDialect={me?.dialect ?? null}
            />
          )}
        </div>

        {!narrow && code && (
          <TranscriptPanel
            lines={lines}
            selfId={selfId}
            me={me}
            peer={peer}
            onCorrect={props.onCorrect}
            onRetry={props.onRetry}
            onSendChat={props.onSendChat}
          />
        )}
      </div>

      <ControlDrawer>
        <DrawerContents
          copy={copy}
          // The whole room header, on the screens that no longer have one of their own.
          header={
            narrow ? (
              <>
                {names}
                {codeControls}
                {drawerChips.length > 0 && <Chips chips={drawerChips} />}
              </>
            ) : null
          }
          language={{
            dialect: me?.dialect ?? "en-US",
            onChangeDialect: props.onChangeDialect,
            translationOn,
            translationMoot,
            onToggleTranslation: () => props.onToggleTranslation(!translationOn),
          }}
          theme={{ choice: theme, onChoose: chooseTheme }}
          chat={{
            onLeave: props.onLeave,
            onEnd: () => setConfirmEnd(true),
            ...(peer && peerContactId && props.safety
              ? { onReport: () => setReporting({ contactId: peerContactId, name: peer.username }) }
              : {}),
          }}
        />
      </ControlDrawer>

      {reporting && props.safety && (
        <SafetyDialog
          contactId={reporting.contactId}
          name={reporting.name}
          actions={props.safety}
          onBlocked={() => props.onBlockedInCall(reporting.name)}
          onClose={() => setReporting(null)}
        />
      )}

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
