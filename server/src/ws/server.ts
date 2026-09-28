// The WebSocket layer: connection lifecycle, message dispatch, and room wiring.
//
// Raw `ws` rather than Socket.IO on purpose. Socket.IO's auto reconnect layer actively obscures
// the distinction between "the WebSocket dropped but WebRTC is alive" and "the user left", and
// that distinction is exactly what the two grace windows are built on. Close codes and explicit
// control are worth more here than the abstraction.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  CLOSE,
  LIMITS,
  type GlossaryEntry,
  parseClientMessage,
  translationNeed,
  WS_PATH,
  type ClientMessage,
  type ErrorCode,
  type Member as WireMember,
  type ServerMessage,
  type SkipReason,
  type TranslationFailureCode,
} from "@translatv/shared";

import type { RoomUserData } from "../account/service.js";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { GRACE_MS, MAX_MEMBERS, RoomManager, type Member } from "../rooms/RoomManager.js";
import { bearerFromUpgrade, selectSubprotocol } from "../auth/bearer.js";
import { roomHash } from "../spend/caps.js";
import {
  LIMITS as RATE,
  MAX_CONNECTIONS_PER_IP,
  TokenBuckets,
} from "../security/rateLimit.js";
import type { TranslationService } from "../translate/TranslationService.js";
import { RoomSession } from "./RoomSession.js";

/** How often expired rooms and seats are swept. */
export const SWEEP_INTERVAL_MS = 5_000;

/**
 * How often every connection is asked whether it is still there.
 *
 * This is a PROTOCOL level ping, which is the only kind the server can draw a conclusion from.
 * The client's own 20 second {t:"ping"} is an application message: it keeps the connection warm
 * from the client's side and says nothing about a client that has gone away. Without this round
 * a half open socket kept its room seat and one of the per address connection slots until TCP
 * gave up, which can be many minutes.
 */
export const PING_INTERVAL_MS = 30_000;

/**
 * Where a translation result's text actually came from.
 *
 * Derived from translationNeed rather than comparing dialect codes, so this cannot disagree with
 * the decision to skip the model. It did disagree once: an en-US to en-GB line was echoed
 * verbatim and reported as "model".
 *
 * "unknown" is unreachable here: a line whose dialects cannot both be resolved is refused before
 * any translation is attempted, so it never produces a result to label. It falls on the "model"
 * side rather than the "echo" side because "echo" is a positive claim that the text was already
 * in the target language, and an unresolvable dialect is precisely the case where nobody can
 * claim that.
 */
export function originFor(sourceDialect: string, targetDialect: string): "model" | "echo" {
  return translationNeed(sourceDialect, targetDialect) === "no" ? "echo" : "model";
}

/**
 * The address to hold responsible for a request.
 *
 * Behind a reverse proxy the socket address is the proxy, so the forwarded header is the only way
 * to see the real client. It is also attacker controlled when nothing is in front, and a spoofed
 * value per request evaporates every per IP limit, the join limiter included.
 *
 * So trusting it is OPT IN rather than inferred from NODE_ENV. Production does not imply a proxy:
 * this repo's own docker-compose maps 8080 straight through, which is exactly the exposed case
 * the old condition treated as trusted.
 *
 * Both directions are a real failure, which is why both are tested. Trusting the header with
 * nothing in front makes every limit bypassable. NOT trusting it behind a proxy collapses every
 * client onto one address, where the connection cap then caps the whole service.
 *
 * Free of IncomingMessage so it can be tested without a socket.
 */
export function clientAddress(
  headers: IncomingMessage["headers"],
  remoteAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    // The NEAREST hop, which is the rightmost entry, NOT the leftmost.
    //
    // X-Forwarded-For grows left to right: the client may send one, and each proxy APPENDS the
    // address it saw. So only the last entry was written by our own proxy; everything left of
    // it came from whoever called it and can say anything at all.
    //
    // Reading the leftmost was a real hole, demonstrated against the login endpoint: twelve
    // wrong passwords with a rotating X-Forwarded-For returned twelve 401s and not one 429,
    // because every attempt looked like a new client. The rate limiter on the single password
    // protecting this app was a no op, and the same trick pinned to someone else's address
    // locks THEM out instead.
    //
    // This assumes exactly one trusted proxy, which is what TRUST_PROXY=1 means here. Behind a
    // chain, this needs to count hops in from the right rather than take one.
    const forwarded = headers["x-forwarded-for"];
    const chain = Array.isArray(forwarded) ? forwarded.join(",") : forwarded;
    const hops = (chain ?? "")
      .split(",")
      .map((hop) => hop.trim())
      .filter((hop) => hop.length > 0);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }
  return remoteAddress ?? "unknown";
}

/**
 * What to do with one finalized line. THREE outcomes, decided once.
 *
 *   skip      nothing was attempted and nothing went wrong. Costs nothing, says nothing loud.
 *   refuse    something IS wrong and the reader has to be told. Costs nothing either.
 *   translate go and spend money.
 *
 * The third outcome is the fix for the dialect collapse. There used to be two, and an
 * unresolvable dialect was quietly sorted into "same_language": the old helper resolved an
 * unknown code to en-US before comparing, so an unknown dialect facing any English speaker read
 * as "you both speak the same language" and the line went out untranslated with no marker and no
 * reason. A skip is a statement that nothing went wrong, so using it here was a small lie told on
 * every line for the rest of the call.
 *
 * The recipient is the person who would READ the translation, which is the other member, so
 * their preference is what decides. That is what makes the toggle per person: turning it off
 * stops your peer's words being translated for you and leaves your words being translated for
 * them, and neither of you can switch it off for the other.
 *
 * ORDER IS DELIBERATE, and it is an order about money. The no-peer case is first and named
 * separately: someone alone in a room also has a target dialect equal to their own, so the
 * language rule would catch it anyway, but reporting "you both speak the same language" to a
 * person with nobody to speak to is its own small lie. recipient_off stays AHEAD of the refusal
 * because it already saves the call outright, and warning someone about a translation nobody was
 * going to make is noise.
 */
export type TranslationPlan =
  | { kind: "skip"; reason: SkipReason }
  | { kind: "refuse"; reason: TranslationFailureCode }
  | { kind: "translate" };

export function translationPlanFor(
  sourceDialect: string,
  targetDialect: string,
  recipient: Member | undefined,
): TranslationPlan {
  if (!recipient) return { kind: "skip", reason: "no_peer" };

  const need = translationNeed(sourceDialect, targetDialect);
  if (need === "no") return { kind: "skip", reason: "same_language" };
  if (!recipient.wantsTranslation) return { kind: "skip", reason: "recipient_off" };
  if (need === "unknown") return { kind: "refuse", reason: "UNRESOLVED_DIALECT" };
  return { kind: "translate" };
}

interface Connection {
  socket: WebSocket;
  /**
   * Unique per socket, and the key for the per connection message limit.
   *
   * The IP is not that key. Two people on one home network share an address, so keying the
   * frame limiter on it splits a single budget between them and closes whichever socket
   * happened to send the frame that tripped it.
   */
  id: string;
  ip: string;
  /**
   * The account this socket was opened by, proved by the access token on the upgrade. Fixed for
   * the life of the socket: a token that expires mid call does not end the call, and the next
   * reconnect has to present a fresh one. The same holds for revocation: signing out, or a
   * refresh family revoked for reuse, ends future sessions but leaves an open socket open. Only
   * deleting the account closes one (disconnectUser).
   */
  userId: string | null;
  /** Set once the connection is in a room. */
  roomCode: string | null;
  memberId: string | null;
  /**
   * Answered the last protocol ping. Set false by each liveness round and true again by the
   * pong listener, so a round that finds it still false has caught a socket that stopped
   * answering. It was declared and written but never READ once, which is what left the reaper
   * missing entirely.
   */
  alive: boolean;
}

/**
 * What the socket layer needs from accounts: turn an access token into a user id, or refuse it.
 * An interface rather than AuthService itself, so the room tests can hand in a stub without a
 * database behind it.
 */
export interface AccessVerifier {
  verifyAccess(token: string, now: number): string | null;
  /**
   * Hear about deleted accounts, so their live sockets can be closed. Optional so the room tests'
   * stub needs none; AuthService has it, and the server subscribes itself in its constructor so
   * the wiring cannot be forgotten in index.ts.
   */
  onAccountDeleted?(listener: (userId: string) => void): () => void;
}

/** A member's open call history row, and who it names on the other end so far. */
interface OpenCall {
  callId: string;
  userId: string;
  peerUserId: string | null;
}

export class SignalingServer {
  private readonly wss: WebSocketServer;
  private readonly rooms = new RoomManager();
  private readonly sessions = new Map<string, RoomSession>();
  private readonly connections = new Map<WebSocket, Connection>();
  /** memberId -> socket, so a room can be addressed without scanning every connection. */
  private readonly byMember = new Map<string, WebSocket>();
  /** Live connection count per address, for the establishment cap. */
  private readonly perIp = new Map<string, number>();

  private readonly createLimiter = new TokenBuckets(RATE.createPerIp);
  private readonly joinLimiter = new TokenBuckets(RATE.joinPerIp);
  /**
   * The same two limits again, keyed by ACCOUNT. The IP buckets alone let one account spread its
   * attempts across addresses; the account buckets alone let one address spread them across
   * accounts it signed up. Both have to pass.
   */
  private readonly createUserLimiter = new TokenBuckets(RATE.createPerUser);
  private readonly joinUserLimiter = new TokenBuckets(RATE.joinPerUser);
  /** The account each accepted upgrade proved, handed from verifyClient to onConnection. */
  private readonly upgradeUsers = new WeakMap<IncomingMessage, string>();
  private readonly messageLimiter = new TokenBuckets(RATE.messagesPerConnection);
  private readonly translationLimiter = new TokenBuckets(RATE.translationsPerRoom);

  /** memberId -> their open call history row. Empty when no RoomUserData was given. */
  private readonly calls = new Map<string, OpenCall>();
  private unsubscribeDeleted: (() => void) | null = null;

  private sweepTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  /** Once only. A per connection warning about a misconfiguration is itself a log flood. */
  private warnedAboutProxy = false;

  constructor(
    server: HttpServer,
    private readonly config: Config,
    private readonly translation: TranslationService,
    private readonly auth: AccessVerifier,
    /**
     * Per user data (M5): stored glossaries merged into rooms, and call history. Optional so the
     * room suites can run without a database; the real server always passes one.
     */
    private readonly userData?: RoomUserData,
  ) {
    this.wss = new WebSocketServer({
      server,
      // Pinned rather than left open. Accepting an upgrade on any path is what allowed a client
      // with the wrong URL to work when it happened to be served from this same origin and fail
      // silently behind a dev proxy, which is a difference no test caught. Refusing anything but
      // the contracted path makes a mismatch fail identically in both modes.
      path: WS_PATH,
      maxPayload: LIMITS.maxPayloadBytes,
      verifyClient: (info, done) => this.verifyUpgrade(info.req, done),
      // A browser offers ["translatv.v1", "bearer.<token>"]; the answer is the app protocol only,
      // so the token is never echoed back in the response.
      handleProtocols: (offered) => selectSubprotocol(offered),
    });

    this.wss.on("connection", (socket, req) => this.onConnection(socket, req));

    this.sweepTimer = setInterval(() => this.sweepAt(Date.now()), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();

    this.pingTimer = setInterval(() => this.pingRound(), PING_INTERVAL_MS);
    this.pingTimer.unref();

    this.unsubscribeDeleted = auth.onAccountDeleted?.((userId) => this.disconnectUser(userId)) ?? null;
  }

  /**
   * The gate on the upgrade: Origin, then account, then the per address cap.
   *
   * ORIGIN. Browsers always send it on a WebSocket upgrade and a page cannot forge it, so for a
   * browser the allowlist is the CSRF defense: it stops a page on another origin from opening a
   * socket with the user's credentials and network position. That stays exactly as it was, and a
   * valid token does NOT buy a bad Origin past it: a hostile page that somehow held a token is
   * still a hostile page.
   *
   * A MISSING Origin is a native client (the iOS app, a test harness), which sends none. It used
   * to be refused outright in production; it is now admitted ONLY with a valid access token,
   * which is the proof a browser's Origin cannot give (docs/PLAN.md, D9).
   *
   * ACCOUNT. Every upgrade must carry a valid access token, in `Authorization: Bearer` (native)
   * or as the "bearer." subprotocol (browser). No token, or a bad or expired one, is refused with
   * 401 here, before a socket exists: room.create and room.join both need an account, and a
   * socket that can do nothing else has no reason to be held open.
   */
  private verifyUpgrade(
    req: IncomingMessage,
    done: (ok: boolean, code?: number, message?: string) => void,
  ): void {
    const origin = req.headers.origin;
    // In development, any localhost or private LAN origin is allowed regardless of port. Vite,
    // the built client, and a test harness on an OS assigned port all differ only by port
    // number, and pinning one turns an ordinary setup into a confusing 403 with no clue
    // attached. The LAN half is what lets a phone on the same wifi load the app from the
    // laptop's address, which is the only way to test a real two device call.
    //
    // Production stays strict: there, the allowlist is the whole CSRF defense.
    if (origin !== undefined) {
      const allowed =
        this.config.allowedOrigins.includes(origin) ||
        (!this.config.isProduction && isDevelopmentOrigin(origin));

      if (!allowed) {
        log.warn("ws.origin_refused", { origin });
        done(false, 403, "origin not allowed");
        return;
      }
    }

    const bearer = bearerFromUpgrade(req.headers);
    const userId = bearer === null ? null : this.auth.verifyAccess(bearer, Date.now());
    if (userId === null) {
      log.warn("ws.unauthenticated", { native: origin === undefined, presented: bearer !== null });
      done(false, 401, "sign in required");
      return;
    }

    // Refused HERE rather than by closing an accepted socket. A socket that opens and is then
    // closed has already fired "open" at the client, so the cap would not read as a refusal to
    // anything on the other end.
    // The misconfiguration that turns two correct settings into an outage: a proxy IS forwarding
    // the header, production IS on, and TRUST_PROXY is not set, so every client collapses onto
    // the proxy's address and the cap below then caps the entire service. Detectable exactly
    // here, and worth one loud line rather than a mystery 429 for the thirteenth visitor.
    if (this.config.isProduction && !this.config.trustProxy && req.headers["x-forwarded-for"]) {
      if (!this.warnedAboutProxy) {
        this.warnedAboutProxy = true;
        log.warn("ws.forwarded_header_ignored", {
          message:
            "X-Forwarded-For is arriving but TRUST_PROXY is not set, so every client counts as " +
            "the proxy's address. Per IP limits and the connection cap now apply to the whole " +
            "service collectively. Set TRUST_PROXY=1 if a proxy is genuinely in front.",
        });
      }
    }

    const ip = this.clientIp(req);
    if ((this.perIp.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      log.warn("ws.connection_cap", { open: this.perIp.get(ip) ?? 0 });
      done(false, 429, "too many connections from this address");
      return;
    }

    this.upgradeUsers.set(req, userId);
    done(true);
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const ip = this.clientIp(req);
    const connection: Connection = {
      socket,
      id: randomUUID(),
      ip,
      userId: this.upgradeUsers.get(req) ?? null,
      roomCode: null,
      memberId: null,
      alive: true,
    };
    this.connections.set(socket, connection);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    socket.on("pong", () => {
      connection.alive = true;
    });
    socket.on("message", (data) => this.onMessage(connection, data.toString()));
    socket.on("close", () => this.onClose(connection));
    socket.on("error", (error) => log.warn("ws.socket_error", { error: error.message }));
  }

  private clientIp(req: IncomingMessage): string {
    return clientAddress(req.headers, req.socket.remoteAddress, this.config.trustProxy);
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  /**
   * Refuse something, by CODE.
   *
   * There is no user facing sentence here any more, and that is the point: the client holds
   * every word a person reads, in the language that person picked, and a sentence written here
   * could only ever be English. `detail` is for a developer reading a console, never for the
   * screen, so it is optional and most refusals have none.
   */
  private fail(socket: WebSocket, code: ErrorCode, fatal = false, detail?: string): void {
    this.send(socket, { t: "error", code, fatal, ...(detail ? { detail } : {}) });
  }

  private onMessage(connection: Connection, raw: string): void {
    const now = Date.now();

    if (!this.messageLimiter.take(connection.id, now)) {
      log.warn("ws.rate_limited", { ip: connection.ip });
      connection.socket.close(CLOSE.rateLimitAbuse, "too many messages");
      return;
    }

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.fail(connection.socket, "MALFORMED", false, parsed.reason);
      return;
    }

    try {
      this.dispatch(connection, parsed.message, now);
    } catch (error) {
      log.error("ws.handler_threw", {
        t: parsed.message.t,
        error: error instanceof Error ? error.message : "unknown",
      });
      this.fail(connection.socket, "MALFORMED", false, "the handler threw");
    }
  }

  private dispatch(connection: Connection, message: ClientMessage, now: number): void {
    switch (message.t) {
      case "ping":
        this.send(connection.socket, { t: "pong" });
        return;
      case "room.create":
        this.handleCreate(connection, message, now);
        return;
      case "room.join":
        this.handleJoin(connection, message, now);
        return;
      case "room.resume":
        this.handleResume(connection, message, now);
        return;
      case "room.leave":
        this.handleLeave(connection, now);
        return;
      case "room.end":
        this.handleEnd(connection, now);
        return;
      case "member.update":
        this.handleMemberUpdate(connection, message);
        return;
      case "rtc.offer":
      case "rtc.answer":
      case "rtc.ice":
        this.relayToPeer(connection, message);
        return;
      case "stt.interim":
        this.handleInterim(connection, message);
        return;
      case "stt.final":
        this.runDetached(message.t, this.handleFinal(connection, message.text, "speech", now));
        return;
      case "chat.send":
        this.runDetached(message.t, this.handleFinal(connection, message.text, "chat", now));
        return;
      case "translation.retry":
        this.runDetached(message.t, this.handleRetry(connection, message.lineId, now));
        return;
      case "glossary.correct":
        this.handleCorrect(connection, message.lineId, message.correctedTranslation);
        return;
      case "glossary.import":
        this.handleImport(connection, message.entries);
        return;
    }
  }

  /**
   * Launch a handler that does not block the dispatch loop, and catch what it throws.
   *
   * These used to be launched with a bare `void`. dispatch's try/catch cannot see a rejection
   * from one: it returns the moment the handler's first await suspends, so anything thrown after
   * that escaped into the process, and Node 20 exits on an unhandled rejection. There is no
   * process level handler in the server to catch it either.
   *
   * Not theoretical. SpendGate.check rethrows anything that is not LedgerNotFound: records()
   * converts a failing statSync, but load() then calls readFileSync, which throws EACCES or
   * EISDIR for a ledger that exists, stats fine, and cannot be read. That travels up through
   * execute, translate, runTranslation and handleFinal with nothing in its way. A whole server
   * of calls should not end because one room's ledger read failed.
   */
  private runDetached(t: ClientMessage["t"], work: Promise<void>): void {
    void work.catch((error: unknown) =>
      log.error("ws.handler_rejected", {
        t,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------------------

  /**
   * Refuse a room entry from a connection that is already in one.
   *
   * bind() overwrites roomCode and memberId, so without this a second create or join orphans the
   * earlier membership while it is still marked connected. onClose only unbinds the current one,
   * so the abandoned room never arms its destroy deadline and is never swept: a permanent leak,
   * five rooms a minute per address.
   *
   * A refusal rather than an implicit leave. A client that does this has a bug, and quietly
   * moving it would hide the bug and still leave a member behind in the old room.
   */
  private alreadyInRoom(connection: Connection): boolean {
    if (connection.roomCode === null) return false;
    this.fail(connection.socket, "ALREADY_IN_ROOM");
    return true;
  }

  /**
   * The account behind this connection, or null after telling it why not.
   *
   * Null is unreachable through an ordinary upgrade, which refuses a socket with no valid token
   * before it exists. Checked anyway because create and join are the two places an anonymous
   * socket would matter, and the check is one comparison.
   */
  private requireUser(connection: Connection): string | null {
    if (connection.userId !== null) return connection.userId;
    this.fail(connection.socket, "UNAUTHENTICATED", true);
    return null;
  }

  /** Both buckets, the address's and the account's. Both are always charged. */
  private takeBoth(ipLimiter: TokenBuckets, userLimiter: TokenBuckets, connection: Connection, userId: string, now: number): boolean {
    const byIp = ipLimiter.take(connection.ip, now);
    const byUser = userLimiter.take(userId, now);
    return byIp && byUser;
  }

  private handleCreate(
    connection: Connection,
    message: Extract<ClientMessage, { t: "room.create" }>,
    now: number,
  ): void {
    if (this.alreadyInRoom(connection)) return;
    const userId = this.requireUser(connection);
    if (userId === null) return;
    if (!this.takeBoth(this.createLimiter, this.createUserLimiter, connection, userId, now)) {
      this.fail(connection.socket, "RATE_LIMITED");
      return;
    }

    // Any signed in account may start a call (docs/PLAN.md, D9), bounded by the limits above and
    // by the spend caps. The creator is the room's host.
    const { room, member, resumeToken } = this.rooms.create(
      message.username,
      message.dialect,
      now,
      userId,
    );
    this.sessions.set(room.code, new RoomSession());
    this.bind(connection, room.code, member.id);

    this.send(connection.socket, {
      t: "room.created",
      code: room.code,
      selfId: member.id,
      resumeToken,
      you: toWire(member),
      polite: member.polite,
      config: { graceMs: GRACE_MS, maxMembers: MAX_MEMBERS },
      iceServers: this.config.iceServers,
    });
    log.info("room.created", { room: roomHash(room.code) });

    this.openCall(member.id, userId, room.code, null, now);
    this.mergeStoredGlossary(room.code, userId);
  }

  private handleJoin(
    connection: Connection,
    message: Extract<ClientMessage, { t: "room.join" }>,
    now: number,
  ): void {
    if (this.alreadyInRoom(connection)) return;
    const userId = this.requireUser(connection);
    if (userId === null) return;
    // The brute force guard on room codes. This is the only real attack surface on room access.
    if (!this.takeBoth(this.joinLimiter, this.joinUserLimiter, connection, userId, now)) {
      this.fail(connection.socket, "RATE_LIMITED");
      return;
    }

    // Sweep through the path that NOTIFIES before asking who is in the room. Expired seats have
    // to be released and acted on (an expired host ends the room) before "is the host present"
    // can mean anything. Asking first, or asking something that sweeps silently, loses the
    // release: the room would be left with a guest in it, unendable and unjoinable.
    this.sweepAt(now);

    // A guest gets in only while the host is sitting in the room. Since the host leaving ends the
    // room, that is really "they started this call and have not left it".
    //
    // An ENDED code is told so, because the person holding it is owed "it ended" rather than
    // "wait for them". Every other absence, a code that never existed included, is
    // HOST_NOT_PRESENT, so a code guesser learns nothing about which codes are live.
    if (!this.rooms.hasHostPresent(message.code)) {
      this.fail(
        connection.socket,
        this.rooms.hasEnded(message.code) ? "ROOM_ENDED" : "HOST_NOT_PRESENT",
        true,
      );
      return;
    }

    const result = this.rooms.join(
      message.code,
      message.username,
      message.dialect,
      now,
      userId,
    );
    if (!result.ok) {
      this.fail(connection.socket, result.error, true);
      return;
    }

    const { room, member, resumeToken } = result;
    const session = this.sessionFor(room.code);
    this.bind(connection, room.code, member.id);

    const peer = room.members.find((m) => m.id !== member.id) ?? null;

    this.send(connection.socket, {
      t: "room.joined",
      code: room.code,
      selfId: member.id,
      resumeToken,
      you: toWire(member),
      peer: peer ? toWire(peer) : null,
      polite: member.polite,
      config: { graceMs: GRACE_MS, maxMembers: MAX_MEMBERS },
      iceServers: this.config.iceServers,
      snapshot: session.snapshot(),
    });

    this.broadcast(room.code, { t: "peer.joined", peer: toWire(member) }, member.id);
    log.info("room.joined", { room: roomHash(room.code), members: room.members.length });

    // The same account on both ends (two tabs, one person) is not a contact of itself.
    const other = peer && peer.userId !== userId ? peer : null;
    this.openCall(member.id, userId, room.code, other?.userId ?? null, now);
    if (other) this.peerCall(other.id, userId, room.code, now);
    this.mergeStoredGlossary(room.code, userId);
  }

  private handleResume(
    connection: Connection,
    message: Extract<ClientMessage, { t: "room.resume" }>,
    now: number,
  ): void {
    if (this.alreadyInRoom(connection)) return;
    // Tied to the account as well as the token: a resume token lifted from someone's browser is
    // useless to anyone signed in as somebody else. Refused as INVALID_RESUME, like a wrong token.
    const result = this.rooms.resume(
      message.code,
      message.resumeToken,
      now,
      connection.userId ?? undefined,
    );
    if (!result.ok) {
      this.fail(connection.socket, result.error, true);
      return;
    }

    const { room, member, resumeToken, evicted } = result;

    // Last writer wins: a second tab claiming the same token evicts the first, so a zombie tab
    // cannot hold a seat its owner is trying to reclaim.
    if (evicted) {
      const old = this.byMember.get(evicted);
      if (old && old !== connection.socket) {
        // Unbind BEFORE closing. close() opens a handshake, it does not stop delivery: ws still
        // dispatches every frame that arrives before the peer answers, and the evicted
        // Connection was still carrying roomCode and memberId through that window. So a socket
        // that had just handed its seat over could still run room.end, room.leave, member.update
        // or chat.send against a room that now belongs to somebody else.
        //
        // The fields are cleared directly rather than through unbind(), so the byMember entry
        // that bind() is about to overwrite two lines below is left alone.
        const stale = this.connections.get(old);
        if (stale) {
          stale.roomCode = null;
          stale.memberId = null;
        }
        old.close(CLOSE.duplicateResume, "this session was resumed elsewhere");
      }
    }

    const session = this.sessionFor(room.code);
    this.bind(connection, room.code, member.id);
    const peer = room.members.find((m) => m.id !== member.id) ?? null;

    this.send(connection.socket, {
      t: "room.joined",
      code: room.code,
      selfId: member.id,
      resumeToken,
      you: toWire(member),
      peer: peer ? toWire(peer) : null,
      polite: member.polite,
      config: { graceMs: GRACE_MS, maxMembers: MAX_MEMBERS },
      iceServers: this.config.iceServers,
      snapshot: session.snapshot(),
    });

    this.broadcast(
      room.code,
      { t: "peer.state", peerId: member.id, connection: "connected" },
      member.id,
    );
    log.info("room.resumed", { room: roomHash(room.code) });
  }

  private handleLeave(connection: Connection, now: number): void {
    const { roomCode, memberId } = connection;
    if (!roomCode || !memberId) return;

    // Read BEFORE the seat is freed: after leave() the member is gone and there is nothing left
    // to ask about.
    const leaver = this.rooms.peek(roomCode)?.members.find((m) => m.id === memberId);
    const hostLeft = leaver?.isHost === true;

    const room = this.rooms.leave(roomCode, memberId, now);
    this.unbind(connection);
    this.closeCall(memberId, now);
    connection.socket.close(CLOSE.normal, "left");

    if (hostLeft) {
      // No calls without the host, by owner decision. An explicit leave is a DECISION, not a
      // dropped connection, so it ends the room immediately rather than holding the guest in a
      // call that cannot be rejoined and can never gain a second person.
      this.endRoom(roomCode, memberId, leaver?.username ?? "someone", now);
      log.info("room.left", { room: roomHash(roomCode), endedByHost: true });
      return;
    }

    if (room) {
      this.broadcast(roomCode, { t: "peer.left", peerId: memberId, reason: "left" }, memberId);
    }
    log.info("room.left", { room: roomHash(roomCode) });
  }

  private handleEnd(connection: Connection, now: number): void {
    const { roomCode, memberId } = connection;
    if (!roomCode || !memberId) return;

    const ender = this.rooms.peek(roomCode)?.members.find((m) => m.id === memberId);
    this.endRoom(roomCode, memberId, ender?.username ?? "someone", now);
  }

  /**
   * Destroy a room and tell whoever is still in it, by name.
   *
   * Shared by the End button and by the host leaving, because those are the same event as far
   * as everyone else in the room is concerned. Keeping one implementation is what stops the two
   * drifting into "ended" meaning something subtly different depending on how it happened.
   */
  private endRoom(roomCode: string, byMemberId: string, byUsername: string, now: number): void {
    const endedRoom = this.rooms.end(roomCode, now);
    if (!endedRoom) return;

    // Tell everyone BEFORE closing their sockets, so the client can freeze its transcript and
    // offer a download rather than just seeing the connection vanish.
    for (const member of endedRoom.members) {
      this.closeCall(member.id, now);
      const socket = this.byMember.get(member.id);
      if (!socket) continue;
      this.send(socket, { t: "room.ended", by: byMemberId, byUsername });
      socket.close(CLOSE.roomEnded, "the chat was ended");
      this.byMember.delete(member.id);
    }

    this.sessions.delete(roomCode);
    this.translation.forgetRoom(roomHash(roomCode));
    log.info("room.ended", { room: roomHash(roomCode) });
  }

  private handleMemberUpdate(
    connection: Connection,
    message: Extract<ClientMessage, { t: "member.update" }>,
  ): void {
    const room = connection.roomCode ? this.rooms.peek(connection.roomCode) : null;
    const member = room?.members.find((m) => m.id === connection.memberId);
    if (!room || !member || !connection.memberId) return;

    if (message.username !== undefined) member.username = message.username;
    if (message.dialect !== undefined) member.dialect = message.dialect;
    if (message.micEnabled !== undefined) member.micEnabled = message.micEnabled;
    if (message.cameraEnabled !== undefined) member.cameraEnabled = message.cameraEnabled;
    if (message.wantsTranslation !== undefined) member.wantsTranslation = message.wantsTranslation;

    this.broadcast(
      room.code,
      {
        t: "peer.updated",
        peerId: connection.memberId,
        ...(message.username !== undefined ? { username: message.username } : {}),
        ...(message.dialect !== undefined ? { dialect: message.dialect } : {}),
        ...(message.micEnabled !== undefined ? { micEnabled: message.micEnabled } : {}),
        ...(message.cameraEnabled !== undefined ? { cameraEnabled: message.cameraEnabled } : {}),
        ...(message.wantsTranslation !== undefined
          ? { wantsTranslation: message.wantsTranslation }
          : {}),
      },
      connection.memberId,
    );
  }

  // -------------------------------------------------------------------------
  // Signaling and conversation
  // -------------------------------------------------------------------------

  /** WebRTC payloads are relayed verbatim. The server is a dumb pipe and never parses SDP. */
  private relayToPeer(connection: Connection, message: ClientMessage): void {
    const peerSocket = this.peerSocket(connection);
    if (!peerSocket || !connection.memberId) return;

    if (message.t === "rtc.offer") {
      this.send(peerSocket, { t: "rtc.offer", from: connection.memberId, sdp: message.sdp });
    } else if (message.t === "rtc.answer") {
      this.send(peerSocket, { t: "rtc.answer", from: connection.memberId, sdp: message.sdp });
    } else if (message.t === "rtc.ice") {
      this.send(peerSocket, {
        t: "rtc.ice",
        from: connection.memberId,
        candidate: message.candidate,
      });
    }
  }

  private handleInterim(
    connection: Connection,
    message: Extract<ClientMessage, { t: "stt.interim" }>,
  ): void {
    // Interim results are relayed and NOT stored, NOT translated, and NOT rate counted against
    // translation. They are the live original language line, which is what makes the UI feel
    // instant while the translated line is still a second away.
    const peerSocket = this.peerSocket(connection);
    if (!peerSocket || !connection.memberId) return;
    this.send(peerSocket, {
      t: "transcript.interim",
      from: connection.memberId,
      text: message.text,
      seq: message.seq,
    });
  }

  private async handleFinal(
    connection: Connection,
    text: string,
    source: "speech" | "chat",
    now: number,
  ): Promise<void> {
    const { roomCode, memberId } = connection;
    if (!roomCode || !memberId) {
      this.fail(connection.socket, "NOT_IN_ROOM");
      return;
    }
    if (text.trim().length === 0) return;

    const room = this.rooms.peek(roomCode);
    const speaker = room?.members.find((m) => m.id === memberId);
    if (!room || !speaker) return;

    // Decide BEFORE the line exists. Everything the decision needs is already known here, so a
    // line nobody will translate is born "skipped" rather than created pending and corrected a
    // frame later. That is what keeps a monolingual room from taking a rate limit token,
    // announcing a pending translation, and being asked whether it can afford one.
    const peer = room.members.find((m) => m.id !== memberId);
    const targetDialect = peer?.dialect ?? speaker.dialect;
    const plan = translationPlanFor(speaker.dialect, targetDialect, peer);

    const session = this.sessionFor(roomCode);
    const line = session.addLine({
      from: memberId,
      username: speaker.username,
      srcDialect: speaker.dialect,
      text,
      source,
      // The reason rides on the line, because a line born skipped gets no second frame and this
      // is the only chance to say why.
      ...(plan.kind === "skip"
        ? { translationStatus: "skipped" as const, skipReason: plan.reason }
        : {}),
    });

    // The original goes out IMMEDIATELY, to everyone including the speaker. A translation
    // failure therefore never costs the user the original line.
    this.broadcastAll(roomCode, { t: "transcript.final", line });

    // Ordered ahead of the "not configured" guard on purpose. On a server with no API key a room
    // where both people speak the same language has nothing to translate, which is a different
    // statement from "translation is unavailable" and must not make the client latch it off.
    if (plan.kind === "skip") return;

    // A dialect nobody could resolve. Refused HERE, before the limiter and before the spend gate,
    // so it costs nothing, and reported as a real failure so it appears on screen. The one thing
    // it must never be is silent: this line went out untranslated, and the reader is the last
    // person who should have to work that out for themselves.
    if (plan.kind === "refuse") {
      const failed = session.setFailed(line.lineId, "unavailable");
      if (failed) {
        this.broadcastAll(roomCode, {
          t: "translation.failed",
          lineId: line.lineId,
          status: "unavailable",
          // The same two codes will not resolve any better on a second attempt.
          retriable: false,
          reason: plan.reason,
        });
      }
      return;
    }

    if (!this.translation.enabled) {
      const failed = session.setFailed(line.lineId, "unavailable");
      if (failed) {
        this.broadcastAll(roomCode, {
          t: "translation.failed",
          lineId: line.lineId,
          status: "unavailable",
          retriable: false,
          reason: "NOT_CONFIGURED",
        });
      }
      return;
    }

    if (!this.translationLimiter.take(roomCode, now)) {
      session.setFailed(line.lineId, "rate_limited");
      this.broadcastAll(roomCode, {
        t: "translation.failed",
        lineId: line.lineId,
        status: "rate_limited",
        retriable: true,
        reason: "TOO_FAST",
      });
      return;
    }

    this.broadcastAll(roomCode, { t: "translation.pending", lineId: line.lineId });
    await this.runTranslation(roomCode, line.lineId, text, speaker.dialect, targetDialect);
  }

  private async runTranslation(
    roomCode: string,
    lineId: string,
    text: string,
    sourceDialect: string,
    targetDialect: string,
  ): Promise<void> {
    const session = this.sessions.get(roomCode);
    if (!session) return;

    const result = await this.translation.translate({
      lineId,
      text,
      sourceDialect,
      targetDialect,
      context: session.contextFor(text),
      glossary: session.glossaryEntries,
      roomHash: roomHash(roomCode),
      // The HOST pays, whoever spoke (docs/PLAN.md, D9). Read off the room rather than the
      // speaker's connection, which is exactly the mistake this line exists not to make.
      userId: this.payerFor(roomCode),
      kind: "translation",
    });

    // The room can end while a translation is in flight. Dropping the result is correct; the
    // handler must simply not throw when the room it belonged to is gone.
    if (!this.sessions.has(roomCode)) return;

    if (result.ok) {
      const updated = session.setTranslation(lineId, result.text, "ok");
      if (!updated) return;
      this.broadcastAll(roomCode, {
        t: "translation.result",
        lineId,
        targetDialect,
        text: result.text,
        revision: updated.revision,
        origin: originFor(sourceDialect, targetDialect),
      });
      return;
    }

    session.setFailed(lineId, result.status);
    this.broadcastAll(roomCode, {
      t: "translation.failed",
      lineId,
      status: result.status,
      retriable: result.retriable,
      reason: result.reason,
    });
  }

  /**
   * The account a room's translation spend is attributed to: its creator.
   *
   * null only for a room with no recorded creator, which the signed in create path never makes
   * (RoomManager defaults the id to "" for its own unit tests). null skips the per user cap and
   * books the row unattributed; the global and room caps still bind it.
   */
  private payerFor(roomCode: string): string | null {
    const host = this.rooms.peek(roomCode)?.hostUserId ?? "";
    return host === "" ? null : host;
  }

  private async handleRetry(connection: Connection, lineId: string, now: number): Promise<void> {
    const { roomCode } = connection;
    if (!roomCode) return;
    const room = this.rooms.peek(roomCode);
    const session = this.sessions.get(roomCode);
    if (!room || !session) return;

    const line = session.find(lineId);
    if (!line) return;

    const speaker = room.members.find((m) => m.id === line.from);
    // Falling back to whoever clicked retry matters when the line's author has left and someone
    // new has taken the seat: "the member who is not the author" then returns the wrong person,
    // and the retry would be aimed at their dialect rather than the reader's.
    const peer =
      room.members.find((m) => m.id !== line.from) ??
      room.members.find((m) => m.id === connection.memberId);
    const targetDialect = peer?.dialect ?? speaker?.dialect ?? line.srcDialect;

    // Before the limiter and before the enabled check, for the same reason as handleFinal: a
    // retry of a line that needs no translation must not cost a token or report a failure.
    const plan = translationPlanFor(line.srcDialect, targetDialect, peer);
    if (plan.kind === "skip") {
      const updated = session.setSkipped(lineId, plan.reason);
      if (updated) {
        this.broadcastAll(roomCode, {
          t: "translation.skipped",
          lineId,
          reason: plan.reason,
          revision: updated.revision,
        });
      }
      return;
    }

    // Same refusal as the fresh line path. Clicking retry on a line whose dialects cannot be
    // resolved must not spend, and must not answer with silence either.
    if (plan.kind === "refuse") {
      const failed = session.setFailed(lineId, "unavailable");
      if (failed) {
        this.broadcastAll(roomCode, {
          t: "translation.failed",
          lineId,
          status: "unavailable",
          retriable: false,
          reason: plan.reason,
        });
      }
      return;
    }

    if (!this.translation.enabled) {
      const failed = session.setFailed(lineId, "unavailable");
      if (failed) {
        this.broadcastAll(roomCode, {
          t: "translation.failed",
          lineId,
          status: "unavailable",
          retriable: false,
          reason: "NOT_CONFIGURED",
        });
      }
      return;
    }

    // Used to return silently. Someone clicks "retry translation", nothing happens, and nothing
    // anywhere says why, which is the endless-spinner failure this app is supposed to not have.
    if (!this.translationLimiter.take(roomCode, now)) {
      session.setFailed(lineId, "rate_limited");
      this.broadcastAll(roomCode, {
        t: "translation.failed",
        lineId,
        status: "rate_limited",
        retriable: true,
        reason: "TOO_FAST",
      });
      return;
    }

    this.broadcastAll(roomCode, { t: "translation.pending", lineId });
    await this.runTranslation(
      roomCode,
      lineId,
      line.text,
      line.srcDialect,
      targetDialect,
    );
  }

  private handleCorrect(connection: Connection, lineId: string, corrected: string): void {
    const { roomCode, memberId } = connection;
    if (!roomCode || !memberId) return;
    const room = this.rooms.peek(roomCode);
    const session = this.sessions.get(roomCode);
    if (!room || !session) return;

    const corrector = room.members.find((m) => m.id === memberId);
    const line = session.correct(lineId, corrected, corrector?.dialect ?? "en-US");
    if (!line) return;

    // The correction applies immediately with NO second API call, and it also lands in the
    // glossary so future translations of the same phrase honor it.
    this.broadcastAll(roomCode, {
      t: "translation.result",
      lineId,
      targetDialect: corrector?.dialect ?? "en-US",
      text: corrected,
      revision: line.revision,
      origin: "correction",
    });
    this.broadcastAll(roomCode, {
      t: "glossary.updated",
      entries: [...session.glossaryEntries],
    });
  }

  private handleImport(
    connection: Connection,
    entries: Extract<ClientMessage, { t: "glossary.import" }>["entries"],
  ): void {
    const { roomCode } = connection;
    if (!roomCode) return;
    this.importGlossary(roomCode, entries);
  }

  /**
   * THE glossary import path: merge entries into a room's glossary by RoomSession's rules and
   * tell everyone in the room. Shared by glossary.import and by a stored glossary joining a room,
   * so the two cannot come to merge differently.
   */
  private importGlossary(roomCode: string, entries: readonly GlossaryEntry[]): void {
    const session = this.sessions.get(roomCode);
    if (!session) return;
    session.importGlossary(entries);
    this.broadcastAll(roomCode, {
      t: "glossary.updated",
      entries: [...session.glossaryEntries],
    });
  }

  // -------------------------------------------------------------------------
  // Per user data: stored glossaries and call history
  // -------------------------------------------------------------------------

  /**
   * A signed in user's stored glossary joins the room they just created or joined. Sent AFTER
   * room.created or room.joined, as a glossary.updated, exactly like an import from the pre join
   * screen, so a client needs nothing new to receive it. Nothing is sent for an empty glossary.
   */
  private mergeStoredGlossary(roomCode: string, userId: string): void {
    const entries = this.userData?.glossaryFor(userId) ?? [];
    if (entries.length === 0) return;
    this.importGlossary(roomCode, entries);
  }

  private openCall(memberId: string, userId: string, roomCode: string, peerUserId: string | null, now: number): void {
    if (!this.userData) return;
    const callId = this.userData.callStarted({ userId, roomHash: roomHash(roomCode), peerUserId, now });
    if (callId !== null) this.calls.set(memberId, { callId, userId, peerUserId });
  }

  /**
   * Someone joined the member's room. A row with nobody on the other end yet gets them. A row
   * that already names somebody (a host whose first guest left before this one arrived) is
   * closed and a new one opened, so each row is one conversation with one person and contacts
   * count calls rather than rooms.
   */
  private peerCall(memberId: string, peerUserId: string, roomCode: string, now: number): void {
    if (!this.userData) return;
    const open = this.calls.get(memberId);
    if (!open) return;
    if (open.peerUserId === null) {
      this.userData.callPeered(open.callId, peerUserId);
      open.peerUserId = peerUserId;
      return;
    }
    this.closeCall(memberId, now);
    this.openCall(memberId, open.userId, roomCode, peerUserId, now);
  }

  private closeCall(memberId: string, now: number): void {
    const open = this.calls.get(memberId);
    if (!open) return;
    this.calls.delete(memberId);
    this.userData?.callEnded(open.callId, now);
  }

  /**
   * An account was deleted: close every live socket it holds, with a NORMAL close code.
   *
   * A socket in a room leaves it through handleLeave, so the room continues or ends by the
   * existing rules (a guest leaving leaves the host a room; the host leaving ends it). A seat
   * held with no socket (mid reconnect) is not chased: its grace window runs out as it would for
   * anyone, and it cannot be resumed, because resuming needs an upgrade and the upgrade needs an
   * account that exists.
   */
  disconnectUser(userId: string): void {
    const now = Date.now();
    let closed = 0;
    for (const connection of [...this.connections.values()]) {
      if (connection.userId !== userId) continue;
      closed += 1;
      if (connection.roomCode && connection.memberId) {
        this.handleLeave(connection, now);
      } else {
        connection.socket.close(CLOSE.normal, "account deleted");
      }
    }
    log.info("ws.account_disconnected", { user: userId, sockets: closed });
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private bind(connection: Connection, code: string, memberId: string): void {
    connection.roomCode = code;
    connection.memberId = memberId;
    this.byMember.set(memberId, connection.socket);
  }

  private unbind(connection: Connection): void {
    if (connection.memberId) this.byMember.delete(connection.memberId);
    connection.roomCode = null;
    connection.memberId = null;
  }

  private sessionFor(code: string): RoomSession {
    let session = this.sessions.get(code);
    if (!session) {
      session = new RoomSession();
      this.sessions.set(code, session);
    }
    return session;
  }

  private peerSocket(connection: Connection): WebSocket | null {
    const room = connection.roomCode ? this.rooms.peek(connection.roomCode) : null;
    if (!room || !connection.memberId) return null;
    const peer = room.members.find((m) => m.id !== connection.memberId);
    if (!peer) return null;
    return this.byMember.get(peer.id) ?? null;
  }

  private broadcast(code: string, message: ServerMessage, exceptMemberId?: string): void {
    const room = this.rooms.peek(code);
    if (!room) return;
    for (const member of room.members) {
      if (member.id === exceptMemberId) continue;
      const socket = this.byMember.get(member.id);
      if (socket) this.send(socket, message);
    }
  }

  private broadcastAll(code: string, message: ServerMessage): void {
    this.broadcast(code, message);
  }

  private onClose(connection: Connection): void {
    const { roomCode, memberId } = connection;
    this.connections.delete(connection.socket);

    // Give the slot back. The cap counts CONCURRENT connections, so a server that never
    // decremented would refuse everyone permanently after enough ordinary churn.
    const open = (this.perIp.get(connection.ip) ?? 1) - 1;
    if (open <= 0) this.perIp.delete(connection.ip);
    else this.perIp.set(connection.ip, open);

    // A close without an explicit leave is a DROP, not a departure: the member keeps their seat
    // for the grace window so a refresh or a tunnel does not cost them the room.
    //
    // Only the socket that CURRENTLY owns the seat may release it. disconnect() used to run
    // unconditionally and the identity check guarded only the byMember map, so a SUPERSEDED
    // socket (evicted by a resume from a newer connection, or already cleared by room.end or by
    // the sweep) still applied a disconnect to a member who was at that instant live on another
    // socket. That armed a 60 second reconnect deadline against a healthy connection, and the
    // sweep then acted on it: the seat was released and the room destroyed underneath someone
    // sitting in it, while their socket stayed open so the client never tried to come back.
    //
    // Every other path into onClose was read against this guard. An ordinary drop is unchanged:
    // the closing socket IS the one in byMember. handleLeave nulls memberId through unbind, so
    // it never reached here. handleEnd deletes byMember first and rooms.end has already removed
    // the room, so disconnect returned null and broadcast nothing: a no-op that now does not
    // happen at all.
    //
    // handleResume also unbinds the socket it evicts, which removes the one trigger reachable
    // today. This guard stays because it is the invariant rather than a patch on that one
    // caller: releasing a seat is the owner's privilege, and the cost of getting it wrong is a
    // user orphaned in a room that then destroys itself around them.
    if (roomCode && memberId && this.byMember.get(memberId) === connection.socket) {
      this.byMember.delete(memberId);
      const room = this.rooms.disconnect(roomCode, memberId, Date.now());
      if (room) {
        this.broadcast(roomCode, {
          t: "peer.state",
          peerId: memberId,
          connection: "reconnecting",
        });
      }
    }
  }

  /**
   * Expire what is due, and tell whoever is affected.
   *
   * `now` is a parameter rather than a Date.now() inside, so a test can run a sweep at a chosen
   * moment. The grace window is a minute and no test is going to wait one, which is why the
   * host timeout path had no coverage at all until it did.
   */
  sweepAt(now: number): void {
    this.rooms.sweep(now);
    // DRAIN rather than read this sweep's own return, so anything an earlier join, resume or
    // presence check swept is announced here too instead of being lost with the call that
    // triggered it.
    const { destroyed, released } = this.rooms.takeSwept();

    for (const { room, member } of released) {
      this.byMember.delete(member.id);
      this.closeCall(member.id, now);
      if (member.isHost) {
        // The host's grace window ran out, so they are gone rather than blinking. This is the
        // other end of the same rule as handleLeave: a transient drop keeps the call alive for
        // the whole grace window and does NOT land here, which is the distinction that stops a
        // wifi hop killing a conversation.
        this.endRoom(room.code, member.id, member.username, now);
        continue;
      }
      this.broadcast(room.code, { t: "peer.left", peerId: member.id, reason: "timeout" });
    }

    for (const room of destroyed) {
      for (const member of room.members) this.closeCall(member.id, now);
      this.sessions.delete(room.code);
      // The third lifetime. Room, session, and translation queue all end here now; the queue used
      // to be left behind and accumulate one entry per room for the life of the process.
      this.translation.forgetRoom(roomHash(room.code));
      log.info("room.destroyed", { room: roomHash(room.code) });
    }

    this.createLimiter.sweep(now);
    this.joinLimiter.sweep(now);
    this.createUserLimiter.sweep(now);
    this.joinUserLimiter.sweep(now);
    this.messageLimiter.sweep(now);
    this.translationLimiter.sweep(now);
  }

  /**
   * One liveness round: reap whatever did not answer the last ping, then ping the rest.
   *
   * Public so a test can run a round immediately rather than waiting PING_INTERVAL_MS, the same
   * reason roomCount and close() are public. Nothing in the app calls it; the timer does.
   */
  pingRound(): void {
    for (const [socket, connection] of this.connections) {
      if (!connection.alive) {
        // terminate(), not close(). A socket that has not answered a ping will not answer a
        // close handshake either, so close() would leave it sitting in CLOSING still holding the
        // seat and the connection slot this round exists to reclaim.
        socket.terminate();
        continue;
      }
      connection.alive = false;
      socket.ping();
    }
  }

  /** For tests and graceful shutdown. */
  close(): void {
    // Rooms die with the process, so every call still open ends now. Without this a graceful
    // restart would leave each one reading "live" forever.
    const now = Date.now();
    for (const memberId of [...this.calls.keys()]) this.closeCall(memberId, now);
    this.unsubscribeDeleted?.();
    this.unsubscribeDeleted = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const socket of this.connections.keys()) socket.close(CLOSE.normal, "server shutting down");
    this.wss.close();
  }

  get roomCount(): number {
    return this.rooms.size;
  }
}

/**
 * Whether an Origin points at this machine or at the local network it is on.
 *
 * Parsed rather than string matched: "http://localhost.evil.com" contains "localhost" and is
 * emphatically not local, and "http://192.168.1.5.evil.example" starts with a private address
 * and is not one. A substring check waves both through.
 *
 * This is a DEVELOPMENT only relaxation, and it is narrower than it looks. A browser sets Origin
 * itself and a page cannot forge it, so a hostile site still arrives as its own origin and is
 * still refused. The only thing admitted here is a page genuinely served from a loopback or
 * private address, which on a development machine is this app being opened from a phone.
 */
function isDevelopmentOrigin(origin: string): boolean {
  let hostname: string;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    return false;
  }

  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;

  // RFC 1918 plus the link local range phones fall back to when DHCP is slow. Each octet is
  // compared as a number, so 172.32.0.1 is correctly outside 172.16.0.0/12 rather than matching
  // a "172." prefix.
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const [a, b] = octets.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) return false;
  if (octets.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;

  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function toWire(member: Member): WireMember {
  return {
    id: member.id,
    username: member.username,
    dialect: member.dialect,
    connection: member.connected ? "connected" : "reconnecting",
    micEnabled: member.micEnabled,
    cameraEnabled: member.cameraEnabled,
    wantsTranslation: member.wantsTranslation,
    isHost: member.isHost,
  };
}

// joinErrorMessage and resumeErrorMessage lived here and wrote the sentence a refused joiner
// read. They are gone: the code alone travels now, and client/src/i18n holds the sentence in
// every language the app speaks. ROOM_NOT_FOUND meant the same thing on both paths anyway, and
// keeping two English phrasings of it here was how the two drifted.
