// The typed WebSocket client, with reconnect and resume.
//
// The reconnect logic here is why this app does NOT use Socket.IO. Its reconnect layer hides
// the distinction between "the socket dropped but WebRTC is alive" and "the user left", and
// that distinction is what the whole grace window design rests on. Here it is explicit:
//
//   an ordinary drop        reconnect with backoff, resume the seat, DO NOT tear down media
//   close code 4000         the room is gone forever. Do not resume, do not reconnect.
//   close code 4001         another tab took this seat. Do not fight it.

import type { ClientMessage, ServerMessage } from "@translatv/shared";
import { CLOSE, WS_PATH } from "@translatv/shared";

const BASE_RECONNECT_MS = 250;
const MAX_RECONNECT_MS = 8_000;
/** Heartbeat, so a dead connection is noticed rather than silently sitting there. */
const PING_INTERVAL_MS = 20_000;

/**
 * WebSocket.OPEN, spelled out.
 *
 * The value is fixed at 1 by the WebSocket standard, so this is not a guess at a constant that
 * could drift. It exists because the global constructor is not there to read it off in a plain
 * Node process, and this module's readyState check runs in the unit suite.
 */
const SOCKET_OPEN = 1;

export interface SocketHandlers {
  onMessage(message: ServerMessage): void;
  onOpen(): void;
  /** terminal true means do not reconnect: the room is gone or the seat was taken. */
  onClose(info: { code: number; terminal: boolean }): void;
  onReconnecting(attempt: number): void;
}

export class SignalingSocket {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Set once we are in a room, so a reconnect can reclaim the seat rather than rejoin. */
  private resume: { code: string; token: string } | null = null;

  constructor(
    private readonly url: string,
    private readonly handlers: SocketHandlers,
  ) {}

  connect(): void {
    this.closedByUs = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_INTERVAL_MS);

      // Reclaim the seat before anything else, so the server does not see a stranger.
      if (this.resume) {
        this.send({
          t: "room.resume",
          code: this.resume.code,
          resumeToken: this.resume.token,
        });
      }
      this.handlers.onOpen();
    };

    socket.onmessage = (event) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }

      // Track the resume credentials as they arrive, and rotate them: the server issues a new
      // token on every join and resume so a captured one cannot be replayed.
      if (message.t === "room.created" || message.t === "room.joined") {
        this.resume = { code: message.code, token: message.resumeToken };
        try {
          sessionStorage.setItem(
            "vt.resume",
            JSON.stringify({ code: message.code, token: message.resumeToken }),
          );
        } catch {
          // Private browsing can refuse sessionStorage. Reconnect within the tab still works
          // from memory; only a reload loses the seat.
        }
      }

      this.handlers.onMessage(message);
    };

    socket.onclose = (event) => {
      this.clearTimers();

      const terminal =
        this.closedByUs ||
        event.code === CLOSE.roomEnded ||
        event.code === CLOSE.duplicateResume ||
        event.code === CLOSE.rateLimitAbuse;

      if (terminal) {
        if (event.code === CLOSE.roomEnded) this.forgetResume();
        this.handlers.onClose({ code: event.code, terminal: true });
        return;
      }

      this.handlers.onClose({ code: event.code, terminal: false });
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows, and that is where the decision lives. Reacting here too would
      // schedule two reconnects for one failure.
    };
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay =
      Math.min(BASE_RECONNECT_MS * 2 ** this.attempt, MAX_RECONNECT_MS) + Math.random() * 250;
    this.handlers.onReconnecting(this.attempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  send(message: ClientMessage): void {
    // SOCKET_OPEN rather than WebSocket.OPEN. This comparison is evaluated even when the socket
    // is null, so reading a property off the global constructor throws outright in any
    // environment that has no global WebSocket, which includes Node before 22 and therefore CI.
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }

    // Dropping is the right call, not queueing. Speech results start flowing before the socket
    // is asked to open, and replaying them once it does would deliver room scoped traffic before
    // the seat exists, which the server refuses and charges to an abuse budget. A lost interim
    // result costs a fraction of a sentence; a replayed one costs the connection.
    //
    // Dropping SILENTLY is the part that was wrong. A wrong socket URL used to present as a
    // screen that simply never moved, with nothing in any log on either side to say why.
    //
    // The message TYPE only. Transcript text, chat text, and usernames never reach a log.
    console.warn(`[signaling] dropped ${message.t}: socket is not open`);
  }

  /** Restore a seat after a page reload, within the grace window. */
  static storedResume(): { code: string; token: string } | null {
    try {
      const raw = sessionStorage.getItem("vt.resume");
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { code?: string; token?: string };
      if (!parsed.code || !parsed.token) return null;
      return { code: parsed.code, token: parsed.token };
    } catch {
      return null;
    }
  }

  adoptResume(resume: { code: string; token: string }): void {
    this.resume = resume;
  }

  forgetResume(): void {
    this.resume = null;
    try {
      sessionStorage.removeItem("vt.resume");
    } catch {
      // Nothing to do; the in memory copy is already cleared.
    }
  }

  close(): void {
    this.closedByUs = true;
    this.forgetResume();
    this.clearTimers();
    this.socket?.close(CLOSE.normal, "leaving");
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
  }
}

/**
 * The WebSocket URL for this origin, honoring https.
 *
 * The path is not optional decoration. Omitting it still connects when the client is served by
 * the app server itself, because there is nothing else on that origin to answer, which is why
 * this was invisible to the end to end run. Behind the dev proxy, which forwards one prefix and
 * keeps the rest for itself, a bare origin reaches the dev server instead of the app and the
 * socket dies somewhere no log records.
 */
export function socketUrl(): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${WS_PATH}`;
}
