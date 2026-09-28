// The WebSocket wire protocol: zod schemas, and the TypeScript types inferred from them.
//
// This file is the SINGLE source of truth for the wire format. Both sides derive their types
// from it, so a message cannot drift between client and server without a compile error, and the
// server's inbound validation IS these schemas rather than a second hand written check that can
// fall out of step with them.
//
// Envelope: { t: "<type>", ...payload }. Every inbound message is parsed; anything that fails
// gets an error{code:"MALFORMED"} and counts against an abuse budget.

import { z } from "zod";
import { DIALECT_CODES } from "./languages.js";

/**
 * The path the signaling socket lives on, for BOTH sides.
 *
 * It lives here rather than being spelled out separately in each because it is part of the wire
 * contract, and because getting it wrong is close to undetectable. The server used to accept an
 * upgrade on any path, so a client that omitted this worked perfectly when it was served from the
 * same origin as the server and failed silently behind a dev proxy that only forwards this exact
 * prefix: no error, no log, just a socket that never reaches the app. One constant, used by the
 * client to build the URL and by the server to refuse anything else, is what keeps the two modes
 * honest with each other.
 */
export const WS_PATH = "/ws";

/**
 * How a BROWSER proves who it is on the socket.
 *
 * A browser cannot set headers on a WebSocket, so it offers two subprotocols:
 * [WS_SUBPROTOCOL, `${WS_BEARER_PREFIX}<access token>`]. The server reads the token from the
 * second and selects the first, so the token is never echoed back and never appears in the URL,
 * where proxy logs and browser history would keep it. Native clients send
 * `Authorization: Bearer <access token>` instead and need neither.
 */
export const WS_SUBPROTOCOL = "translatv.v1";
export const WS_BEARER_PREFIX = "bearer.";

/**
 * The version of the wire format described by this file.
 *
 * Served on /healthz so a client built separately from this server (the iOS app, which ships on
 * its own schedule through an app store review) can find out what it is about to speak BEFORE it
 * opens a socket, and refuse politely instead of failing on the first frame it cannot decode.
 * Bump it on any change a client already in the field could not parse: a removed or renamed
 * field, a new required field, or a changed meaning. Adding an optional field or a new message
 * type an old client can ignore does not need a bump.
 */
export const PROTOCOL_VERSION = 2;

/** Room codes are 8 Crockford base32 characters. The alphabet excludes I, L, O, and U. */
export const ROOM_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Caps on user supplied text. Enforced server side: a client is free to lie, and these are the
 * numbers that decide how much memory one connection can make the server hold.
 */
export const LIMITS = {
  username: 24,
  transcript: 2000,
  chat: 2000,
  glossaryTerm: 200,
  glossaryTranslation: 400,
  glossaryEntries: 40,
  /** ws maxPayload. A frame larger than this closes the socket rather than being parsed. */
  maxPayloadBytes: 8192,
} as const;

export const dialectCode = z.string().refine((v) => DIALECT_CODES.includes(v), {
  message: "unknown dialect",
});

export const roomCode = z.string().regex(ROOM_CODE_PATTERN, "malformed room code");

/**
 * Usernames: trimmed, length capped, and stripped of control and format characters.
 *
 * The format category matters as much as the control one: U+202E RIGHT-TO-LEFT OVERRIDE and
 * friends let a username visually impersonate another user's name in the header. Stripping is
 * better than rejecting because a user pasting a name with a stray zero width space should not
 * see a validation error they cannot see the cause of.
 */
export const username = z
  .string()
  .transform((v) => v.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim())
  .refine((v) => v.length >= 1 && v.length <= LIMITS.username, {
    message: `username must be 1 to ${LIMITS.username} characters`,
  });

const bodyText = (max: number) =>
  z
    .string()
    .transform((v) => v.replace(/[\p{Cc}]/gu, " ").replace(/\r\n/g, "\n").trim())
    .refine((v) => v.length <= max, { message: `text must be at most ${max} characters` });

export const glossaryEntry = z.object({
  source: bodyText(LIMITS.glossaryTerm),
  target: bodyText(LIMITS.glossaryTranslation),
  sourceDialect: dialectCode,
  targetDialect: dialectCode,
});
export type GlossaryEntry = z.infer<typeof glossaryEntry>;

// ---------------------------------------------------------------------------
// Client to server
// ---------------------------------------------------------------------------

export const clientMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("room.create"),
    username,
    dialect: dialectCode,
    wantsVideo: z.boolean(),
    // No credential here. WHO is starting the call was settled when the socket was opened: the
    // upgrade carries an access token (Authorization: Bearer, or the "bearer." subprotocol from a
    // browser) and an unauthenticated upgrade is refused before any frame is read. The admin
    // token that used to ride on this message is retired with the admin password (M3).
  }),
  z.object({
    t: z.literal("room.join"),
    code: roomCode,
    username,
    dialect: dialectCode,
  }),
  z.object({
    t: z.literal("room.resume"),
    code: roomCode,
    resumeToken: z.string().min(1).max(128),
  }),
  z.object({ t: z.literal("room.leave") }),
  z.object({ t: z.literal("room.end") }),
  // A partial patch of your own member record. Every field is optional and only the ones present
  // are applied, so the mic toggle and the dialect picker can use the same message without
  // either clobbering the other.
  //
  // Media state rides here rather than on a message of its own because it has to live on Member
  // regardless: someone joining later must see that you are already muted, and Member is what the
  // room.joined snapshot carries. A second message would be a second way to write the same
  // fields, which is exactly the duplicate this file exists to prevent.
  z.object({
    t: z.literal("member.update"),
    username: username.optional(),
    dialect: dialectCode.optional(),
    micEnabled: z.boolean().optional(),
    cameraEnabled: z.boolean().optional(),
    wantsTranslation: z.boolean().optional(),
  }),

  // WebRTC signaling. The SDP and candidate payloads are relayed verbatim: the server is a
  // dumb pipe here and deliberately does not parse them.
  z.object({ t: z.literal("rtc.offer"), sdp: z.string().max(64_000) }),
  z.object({ t: z.literal("rtc.answer"), sdp: z.string().max(64_000) }),
  z.object({ t: z.literal("rtc.ice"), candidate: z.unknown() }),

  z.object({
    t: z.literal("stt.interim"),
    text: bodyText(LIMITS.transcript),
    seq: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal("stt.final"),
    text: bodyText(LIMITS.transcript),
    seq: z.number().int().nonnegative(),
  }),
  z.object({ t: z.literal("chat.send"), text: bodyText(LIMITS.chat) }),

  z.object({ t: z.literal("translation.retry"), lineId: z.string().min(1).max(64) }),
  z.object({
    t: z.literal("glossary.correct"),
    lineId: z.string().min(1).max(64),
    correctedTranslation: bodyText(LIMITS.glossaryTranslation),
  }),
  z.object({
    t: z.literal("glossary.import"),
    entries: z.array(glossaryEntry).max(LIMITS.glossaryEntries),
  }),

  z.object({ t: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessage>;

// ---------------------------------------------------------------------------
// Server to client
// ---------------------------------------------------------------------------

/**
 * Why something a user asked for was refused.
 *
 * A zod enum rather than a bare array, so this list is a SCHEMA like everything else in this
 * file and not a second kind of truth sitting beside them. Both the codes below and the
 * translation failure codes under them are the whole of what the server says about a refusal:
 * the words a person reads are chosen by the client from the reader's own language files, which
 * is the only way the same refusal can be readable to someone reading in Spanish.
 *
 * ALREADY_IN_ROOM: the connection is already bound to a room and tried to enter another. A
 * refusal rather than an implicit leave. A client sending this has a bug, and moving it silently
 * would hide that bug while orphaning the membership it left behind.
 */
export const errorCode = z.enum([
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "ROOM_ENDED",
  "BAD_CODE",
  "INVALID_RESUME",
  "RATE_LIMITED",
  "PAYLOAD_TOO_LARGE",
  "MALFORMED",
  "NOT_IN_ROOM",
  "ALREADY_IN_ROOM",
  /**
   * The room's host is not in it, so there is nobody to be a guest OF. Also the answer for a code
   * with no live room behind it, so a guesser learns nothing about which codes exist.
   *
   * Deliberately distinct from ROOM_ENDED, which a code that WAS a room still gets: someone who
   * arrives after the host ended the call is owed "it ended", not "wait for them".
   */
  "HOST_NOT_PRESENT",
  /**
   * This connection is not signed in. Unreachable through an ordinary upgrade, which refuses an
   * unauthenticated socket with 401 before any frame is read; kept so that if a socket ever did
   * arrive at create or join without an account, the refusal would say so rather than guess.
   */
  "UNAUTHENTICATED",
]);
export const ERROR_CODES = errorCode.options;
export type ErrorCode = z.infer<typeof errorCode>;

/**
 * Why a line could not be translated, as a code the client turns into a sentence.
 *
 * These used to travel as English prose in a `message` field that rendered straight onto the
 * screen, which meant a Spanish reader was told in English why their subtitles had stopped.
 * They are finer grained than TranslationStatus on purpose: status decides whether a retry
 * button appears, and these decide what the sentence beside it says.
 *
 * PROVIDER_REJECTED and PROVIDER_ERROR deliberately carry NO provider text. The provider's own
 * message is operator diagnostics, it is written in English by somebody else, and it can quote
 * configuration back at whoever is reading. It belongs in the server log, which is where it
 * still goes.
 */
export const translationFailureCode = z.enum([
  /** No API key, so nothing was ever going to be translated on this server. */
  "NOT_CONFIGURED",
  /** The provider refused in a way retrying cannot fix, so translation latched off. */
  "PROVIDER_REJECTED",
  /** Too many translations already in flight in this process. */
  "TOO_MANY_IN_FLIGHT",
  /** This room is producing lines faster than its rate limit allows. */
  "TOO_FAST",
  "DAILY_CAP",
  "ROOM_CAP",
  /** The spend ledger could not be read, so spending was refused rather than risked. */
  "LEDGER_UNREADABLE",
  /**
   * The ledger could not be WRITTEN, so translation stopped rather than spend untracked.
   *
   * A separate code from LEDGER_UNREADABLE because the two are different facts and the reader is
   * owed the right one: a ledger that is missing and a ledger that is there but read only are
   * fixed by different things.
   */
  "LEDGER_UNWRITABLE",
  /**
   * A dialect in this call is not one the server recognizes, so it refused rather than guess.
   *
   * The one failure the reader can actually fix, by picking their language again, which is why
   * it is its own code instead of folding into PROVIDER_ERROR. Deliberately vague about WHICH
   * side was unresolvable: the reader cannot see the other person's picker, and naming them
   * would invite blame for something the app got wrong.
   */
  "UNRESOLVED_DIALECT",
  /** The model answered with nothing at all. */
  "EMPTY_RESULT",
  "TIMED_OUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_ERROR",
]);
export const TRANSLATION_FAILURE_CODES = translationFailureCode.options;
export type TranslationFailureCode = z.infer<typeof translationFailureCode>;

/**
 * WebSocket close codes.
 *
 * These carry meaning the client acts on, so they are named rather than inline. 4000 in
 * particular must be distinguishable from an ordinary drop: it means the room is gone forever,
 * so the client must NOT attempt to resume.
 */
export const CLOSE = {
  normal: 1000,
  roomEnded: 4000,
  duplicateResume: 4001,
  rateLimitAbuse: 4002,
  protocolViolation: 4003,
} as const;

/** An ICE server entry, sent on room.created and room.joined for the peer connection. */
export const rtcIceServerConfig = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type RTCIceServerConfig = z.infer<typeof rtcIceServerConfig>;

const connectionState = z.enum(["connected", "reconnecting"]);

export const member = z.object({
  id: z.string(),
  username: z.string(),
  dialect: z.string(),
  connection: connectionState,
  /** Their microphone is live. A muted person is not transcribed either. */
  micEnabled: z.boolean(),
  /** They are sending live video RIGHT NOW. Not the same as owning a camera: someone who joined
   *  without one and someone who turned theirs off need different words on screen, and only the
   *  receiver's track list can tell those apart. */
  cameraEnabled: z.boolean(),
  /** They want to READ translations. Off means nothing anyone says gets translated FOR THEM,
   *  which is what saves the API call, and says nothing about the other direction. */
  wantsTranslation: z.boolean(),
  /**
   * This member CREATED the room, which makes them its host: the room ends when they leave, and a
   * guest can join only while they are in it.
   *
   * Decided by the SERVER and never sent by the client, so it is a fact rather than a claim. The
   * client reads it off `me` to decide what to show, which keeps one authority for the answer.
   * Renamed from isAdmin (protocol version 2): with accounts, every signed in person can host.
   */
  isHost: z.boolean(),
});
export type Member = z.infer<typeof member>;

export const transcriptLine = z.object({
  lineId: z.string(),
  from: z.string(),
  srcDialect: z.string(),
  text: z.string(),
  source: z.enum(["speech", "chat"]),
  ts: z.string(),
});
export type TranscriptLine = z.infer<typeof transcriptLine>;

/**
 * What happened to a line's translation.
 *
 * "skipped" is deliberately NOT a failure. Nothing was attempted and nothing went wrong: either
 * both people share a language, or the person who would read it does not want translations, or
 * there is nobody else in the room. Rendering it as a failure would offer a retry button whose
 * only effect is to spend money on a line nobody asked to translate.
 */
export const translationStatus = z.enum([
  "ok",
  "skipped",
  "unavailable",
  "rate_limited",
  "budget_exceeded",
]);
export type TranslationStatus = z.infer<typeof translationStatus>;

/**
 * WHY a line was skipped.
 *
 * Three reasons rather than two: calling the solo case "same_language" would be a small lie, and
 * a line nobody was there to read is a different fact from two people who happen to share a
 * language.
 *
 * Declared HERE, once, because it travels on the wire twice: on translation.skipped, and on
 * RenderedLine itself. The server used to declare its own copy of this union, which is the
 * duplicate wire type this file exists to prevent.
 */
export const skipReason = z.enum(["same_language", "recipient_off", "no_peer"]);
export type SkipReason = z.infer<typeof skipReason>;

/** A transcript line plus whatever translation state it currently has. */
export const renderedLine = transcriptLine.extend({
  translated: z.string().nullable(),
  translationStatus: z.enum([...translationStatus.options, "pending"]),
  revision: z.number(),
  /**
   * Why this line's translation failed, when it did.
   *
   * Written by the client from the translation.failed frame, not by the server: the room holds
   * no memory of it, so a line replayed in a resume snapshot arrives with the marker and without
   * a reason. That is the honest state of affairs after a reload rather than a gap worth
   * papering over, and the alternative is the server keeping a per line failure log that nothing
   * else needs.
   */
  failureReason: translationFailureCode.optional(),
  /**
   * Why this line was skipped, or null because it was not.
   *
   * On the LINE rather than only on the translation.skipped frame, because most skipped lines
   * never get a frame: the server decides before the line exists, so it is born "skipped" and
   * arrives on transcript.final with no second message. The reason used to live only on the
   * retry path, which meant the ordinary case carried no reason at all and the three causes
   * rendered identically on screen: the same words, large, with nothing to tell them apart.
   *
   * A SKIP is not a FAILURE and the two never both apply: skipReason says nothing was attempted
   * and nothing went wrong, failureReason says something was attempted and did.
   *
   * Required rather than optional, and null rather than absent, so "not skipped" is a thing the
   * line SAYS instead of a thing a reader infers from a missing key.
   */
  skipReason: skipReason.nullable(),
});
export type RenderedLine = z.infer<typeof renderedLine>;

const roomConfig = z.object({ graceMs: z.number(), maxMembers: z.number() });

/**
 * Every message the server sends.
 *
 * A schema rather than a plain TypeScript union so it can be exported (shared/wire/schema.json)
 * and checked against golden fixtures, which is what lets a second client in another language
 * (the iOS app) be verified against this file instead of against somebody's reading of it. The
 * server does not parse its own output with it at runtime: it is the contract, not a filter.
 */
export const serverMessage = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("room.created"),
    code: z.string(),
    selfId: z.string(),
    resumeToken: z.string(),
    you: member,
    /**
     * Perfect negotiation role. The creator is impolite (it wins offer collisions and is the
     * side that initiates), so the two peers can never both be polite and deadlock.
     */
    polite: z.boolean(),
    config: roomConfig,
    iceServers: z.array(rtcIceServerConfig),
  }),
  z.object({
    t: z.literal("room.joined"),
    code: z.string(),
    selfId: z.string(),
    resumeToken: z.string(),
    you: member,
    peer: member.nullable(),
    polite: z.boolean(),
    config: roomConfig,
    iceServers: z.array(rtcIceServerConfig),
    snapshot: z.object({ lines: z.array(renderedLine), glossary: z.array(glossaryEntry) }),
  }),
  z.object({ t: z.literal("peer.joined"), peer: member }),
  z.object({
    t: z.literal("peer.left"),
    peerId: z.string(),
    reason: z.enum(["left", "timeout", "ended"]),
  }),
  z.object({
    t: z.literal("peer.updated"),
    peerId: z.string(),
    username: z.string().optional(),
    dialect: z.string().optional(),
    micEnabled: z.boolean().optional(),
    cameraEnabled: z.boolean().optional(),
    wantsTranslation: z.boolean().optional(),
  }),
  z.object({ t: z.literal("peer.state"), peerId: z.string(), connection: connectionState }),
  z.object({ t: z.literal("room.ended"), by: z.string(), byUsername: z.string() }),
  z.object({ t: z.literal("rtc.offer"), from: z.string(), sdp: z.string() }),
  z.object({ t: z.literal("rtc.answer"), from: z.string(), sdp: z.string() }),
  z.object({ t: z.literal("rtc.ice"), from: z.string(), candidate: z.unknown() }),
  z.object({
    t: z.literal("transcript.interim"),
    from: z.string(),
    text: z.string(),
    seq: z.number(),
  }),
  // Carries a RenderedLine, not a bare TranscriptLine: a line arriving in a resume snapshot
  // already has translation state, and the client stores both shapes in one list.
  z.object({ t: z.literal("transcript.final"), line: renderedLine }),
  z.object({ t: z.literal("translation.pending"), lineId: z.string() }),
  // Only the retry path needs this. On a fresh line the server decides BEFORE creating it, so the
  // line is born "skipped" and arrives that way on transcript.final, with no second frame. A
  // retry acts on a line the client already has, so that one needs telling.
  z.object({
    t: z.literal("translation.skipped"),
    lineId: z.string(),
    reason: skipReason,
    /** Carried for the same reason translation.result carries it: a late skip must not clobber
     *  a glossary correction that landed first. */
    revision: z.number(),
  }),
  z.object({
    t: z.literal("translation.result"),
    lineId: z.string(),
    targetDialect: z.string(),
    text: z.string(),
    /** Bumped when a glossary correction supersedes an earlier translation of the same line. */
    revision: z.number(),
    origin: z.enum(["model", "correction", "echo"]),
  }),
  z.object({
    t: z.literal("translation.failed"),
    lineId: z.string(),
    status: translationStatus.exclude(["ok", "skipped"]),
    retriable: z.boolean(),
    /** The code the reader's own copy is looked up by. Never prose. */
    reason: translationFailureCode,
  }),
  z.object({ t: z.literal("glossary.updated"), entries: z.array(glossaryEntry) }),
  // `detail` is DIAGNOSTIC, for a developer reading a console or a log, and is never rendered:
  // the sentence a user reads comes from `code`. It is named detail rather than message so that
  // putting it on screen out of habit reads as the mistake it is. MALFORMED is why it survives
  // at all: "expected boolean, received string" is exactly what a client author needs and
  // exactly what a person in a call must never be shown.
  z.object({
    t: z.literal("error"),
    code: errorCode,
    detail: z.string().optional(),
    fatal: z.boolean(),
  }),
  z.object({ t: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof serverMessage>;

/**
 * Parse an inbound frame.
 *
 * Returns a discriminated result rather than throwing, because a malformed frame is an expected
 * condition on a public endpoint, not an exceptional one, and the caller needs to count it.
 */
export function parseClientMessage(
  raw: string,
): { ok: true; message: ClientMessage } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  const parsed = clientMessage.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: parsed.error.issues[0]?.message ?? "failed validation" };
  }
  return { ok: true, message: parsed.data };
}
