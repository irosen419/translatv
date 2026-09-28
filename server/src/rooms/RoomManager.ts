// The room lifecycle state machine.
//
// Deliberately PURE with respect to time and IO: no setTimeout lives in here, and no socket is
// touched. Every transition takes an explicit `now` and returns a result the caller acts on.
// That is what makes the edge case table testable without faking timers, and the edge cases are
// where every bug in this shape of app lives.
//
// TWO INDEPENDENT 60 SECOND TIMERS, and conflating them is the classic mistake:
//
//   reconnectDeadline (per MEMBER) holds a SEAT while that member is reconnecting. A member who
//     refreshed still occupies one of the two seats, so a stranger cannot take it out from under
//     them.
//   destroyDeadline (per ROOM) holds the ROOM while it is entirely unoccupied. It is what makes
//     a refresh by the LAST person in the room survivable.
//
// A room is "occupied" if any member is connected. destroyDeadline is armed on the occupied to
// unoccupied transition and cleared on the reverse.

import { createHash, timingSafeEqual } from "node:crypto";
import { generateCode, generateResumeToken, normalizeCode } from "./codes.js";

export const MAX_MEMBERS = 2;

/** How long an emptied room stays joinable, and how long a dropped member keeps a seat. */
export const GRACE_MS = 60_000;

/**
 * How long a dead code stays refused with ROOM_ENDED rather than ROOM_NOT_FOUND.
 *
 * "Dead forever" is bounded by process lifetime and this cap. With 40 bit codes the practical
 * chance of a collision resurrecting an ended room is nil, so the honest thing is to say that
 * in the docs rather than to claim an eternity the process cannot deliver.
 */
export const TOMBSTONE_TTL_MS = 60 * 60_000;
export const TOMBSTONE_MAX = 10_000;

export interface Member {
  id: string;
  username: string;
  dialect: string;
  /** sha256 of the resume token. The raw token is returned once and never stored. */
  resumeTokenHash: string;
  connected: boolean;
  /** When this member's seat expires if they do not come back. Null while connected. */
  reconnectDeadline: number | null;
  /** Perfect negotiation role. The first member in a room is impolite. */
  polite: boolean;
  /**
   * The account this seat belongs to. Recorded server side only: the peer is sent the opaque
   * member id and never this, so being in a call with someone does not hand you their account id.
   */
  userId: string;
  /**
   * This member CREATED the room, which makes them its host.
   *
   * Set by the server at create time, never from anything the client asserts. The room needs it
   * for two decisions: whether a guest may join at all (only while the host is present), and
   * whether the room dies when this member leaves (it does).
   */
  isHost: boolean;
  /** Their microphone is live. */
  micEnabled: boolean;
  /** They are sending live video right now, which is not the same as owning a camera. */
  cameraEnabled: boolean;
  /** They want to read translations. Off means nobody's words get translated FOR THEM, which is
   *  where the API call is actually saved. Says nothing about the other direction. */
  wantsTranslation: boolean;
}

/**
 * What a member starts out as, shared by create and join so the two cannot drift.
 *
 * cameraEnabled starts FALSE even though most people join with a camera, because the two wrong
 * answers are not equally bad. Claiming a camera is on when it is not shows the other person an
 * empty video frame with nothing to explain it. Claiming it is off when it is on shows a
 * placeholder for about one round trip and then corrects itself, because the client asserts its
 * real media state as soon as it is in the room.
 *
 * wantsTranslation starts TRUE, which is exactly today's behavior, so turning this on is not a
 * silent change to what anyone already has.
 */
export const MEMBER_DEFAULTS = {
  micEnabled: true,
  cameraEnabled: false,
  wantsTranslation: true,
} as const;

export interface Room {
  code: string;
  members: Member[];
  /**
   * The account that created the room, which is who pays for its translation (docs/PLAN.md, D9
   * and D10). Fixed at create and never reassigned, so it is a fact about the ROOM rather than a
   * lookup over its members: the answer cannot depend on which seats happen to be held at the
   * moment a translation is booked, and nothing a guest does can move the bill onto them.
   */
  readonly hostUserId: string;
  /** When the room is destroyed if nobody returns. Null while occupied. */
  destroyDeadline: number | null;
  createdAt: number;
}

export type JoinFailure = "ROOM_NOT_FOUND" | "ROOM_FULL" | "ROOM_ENDED" | "BAD_CODE";

export type JoinResult =
  | { ok: true; room: Room; member: Member; resumeToken: string }
  | { ok: false; error: JoinFailure };

export type ResumeResult =
  | { ok: true; room: Room; member: Member; resumeToken: string; evicted: string | null }
  | { ok: false; error: "ROOM_NOT_FOUND" | "ROOM_ENDED" | "INVALID_RESUME" | "BAD_CODE" };

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant time comparison of two hex digests.
 *
 * A plain === would leak, through timing, how many leading characters of a guessed token were
 * right, which turns a 128 bit secret into a character at a time search.
 */
function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

let memberCounter = 0;
function nextMemberId(): string {
  memberCounter += 1;
  return `m${memberCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RoomManager {
  /** Swept events waiting to be announced. Drained by takeSwept. */
  private swept: { destroyed: Room[]; released: Array<{ room: Room; member: Member }> } = {
    destroyed: [],
    released: [],
  };

  private readonly rooms = new Map<string, Room>();
  /** code -> when the tombstone expires. */
  private readonly tombstones = new Map<string, number>();

  get size(): number {
    return this.rooms.size;
  }

  get tombstoneCount(): number {
    return this.tombstones.size;
  }

  peek(code: string): Room | null {
    return this.rooms.get(normalizeCode(code)) ?? null;
  }

  /**
   * Is the host sitting in this room right now?
   *
   * Reads, and deliberately does NOT sweep. It used to, and swallowing the result was a bug with
   * teeth: this call would delete the host's own expired seat, the caller's sweep would then find
   * nothing released, and the room would never be ended. The guest was left in a room that could
   * not end, was never told the host had gone, and that nobody could join.
   *
   * So the CALLER sweeps, through the path that also notifies, before asking. There is one caller
   * and it does exactly that.
   *
   * A RECONNECTING host counts as present: they still hold their seat, and a guest arriving during
   * a thirty second wifi hop should not be turned away from a call that is still very much
   * happening.
   */
  hasHostPresent(code: string): boolean {
    const room = this.rooms.get(normalizeCode(code));
    return room?.members.some((m) => m.isHost) ?? false;
  }

  /** Was this code ended (or destroyed) recently enough to still be refused as ROOM_ENDED? */
  hasEnded(code: string): boolean {
    return this.tombstones.has(normalizeCode(code));
  }

  /** The creator is the host, always: that is what host means. */
  create(
    username: string,
    dialect: string,
    now: number,
    userId = "",
  ): { room: Room; member: Member; resumeToken: string } {
    const code = this.allocateCode();
    const resumeToken = generateResumeToken();
    const member: Member = {
      id: nextMemberId(),
      username,
      dialect,
      resumeTokenHash: hashToken(resumeToken),
      connected: true,
      reconnectDeadline: null,
      // The creator is impolite: it initiates and wins offer collisions. Fixing the role at
      // creation is what stops both peers being polite and deadlocking on renegotiation.
      polite: false,
      userId,
      isHost: true,
      ...MEMBER_DEFAULTS,
    };
    const room: Room = {
      code,
      members: [member],
      hostUserId: userId,
      destroyDeadline: null,
      createdAt: now,
    };
    this.rooms.set(code, room);
    return { room, member, resumeToken };
  }

  join(
    rawCode: string,
    username: string,
    dialect: string,
    now: number,
    userId = "",
  ): JoinResult {
    const code = normalizeCode(rawCode);
    if (code.length !== 8) return { ok: false, error: "BAD_CODE" };

    this.sweep(now);

    if (this.tombstones.has(code)) return { ok: false, error: "ROOM_ENDED" };

    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };

    // A RECONNECTING member still holds a seat. That is the entire point of the per member
    // deadline: a refresh must not hand your seat to a stranger.
    if (room.members.length >= MAX_MEMBERS) return { ok: false, error: "ROOM_FULL" };

    const resumeToken = generateResumeToken();
    const member: Member = {
      id: nextMemberId(),
      username,
      dialect,
      resumeTokenHash: hashToken(resumeToken),
      connected: true,
      reconnectDeadline: null,
      polite: true,
      userId,
      isHost: false,
      ...MEMBER_DEFAULTS,
    };
    room.members.push(member);
    room.destroyDeadline = null;
    return { ok: true, room, member, resumeToken };
  }

  /**
   * Reclaim a seat with a resume token.
   *
   * A wrong token is refused outright rather than silently falling back to a fresh join. The
   * fallback would look friendlier and would be a seat stealing bug: anyone who knew the code
   * could send a junk token and be quietly seated as a new member.
   */
  /**
   * `userId`, when given, must be the account the seat belongs to. A resume token is a bearer
   * credential for a seat; tying it to the account as well means a token lifted from one person's
   * browser storage is useless to anyone signed in as somebody else.
   */
  resume(rawCode: string, token: string, now: number, userId?: string): ResumeResult {
    const code = normalizeCode(rawCode);
    if (code.length !== 8) return { ok: false, error: "BAD_CODE" };

    this.sweep(now);

    if (this.tombstones.has(code)) return { ok: false, error: "ROOM_ENDED" };

    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: "ROOM_NOT_FOUND" };

    const hash = hashToken(token);
    const member = room.members.find((m) => tokensMatch(m.resumeTokenHash, hash));
    if (!member) return { ok: false, error: "INVALID_RESUME" };
    // Refused with the same code as a wrong token, and BEFORE anything is rotated or evicted, so
    // the rightful owner's live seat is untouched by the attempt.
    if (userId !== undefined && member.userId !== userId) return { ok: false, error: "INVALID_RESUME" };

    // Last writer wins. A second tab claiming the same token evicts the first, so a zombie tab
    // cannot hold a seat that its owner is trying to reclaim.
    const evicted = member.connected ? member.id : null;

    member.connected = true;
    member.reconnectDeadline = null;
    room.destroyDeadline = null;

    // Rotate the token on every resume, so a token captured once cannot be replayed later.
    const resumeToken = generateResumeToken();
    member.resumeTokenHash = hashToken(resumeToken);

    return { ok: true, room, member, resumeToken, evicted };
  }

  /**
   * Intentional departure. The seat is freed IMMEDIATELY, with no grace period.
   *
   * Leaving is a decision, unlike a dropped connection, so holding the seat for 60 seconds
   * afterwards would just make the room look full to the friend the code was sent to.
   */
  leave(code: string, memberId: string, now: number): Room | null {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return null;

    room.members = room.members.filter((m) => m.id !== memberId);
    if (room.members.length === 0) {
      this.armDestroy(room, now);
    }
    return room;
  }

  /**
   * A connection dropped without an explicit leave. The member keeps their seat for the grace
   * window, so a refresh, a tunnel, or a flaky wifi hop does not cost them the room.
   */
  disconnect(code: string, memberId: string, now: number): Room | null {
    const room = this.rooms.get(normalizeCode(code));
    if (!room) return null;

    const member = room.members.find((m) => m.id === memberId);
    if (!member) return room;

    member.connected = false;
    member.reconnectDeadline = now + GRACE_MS;

    if (!room.members.some((m) => m.connected)) {
      this.armDestroy(room, now);
    }
    return room;
  }

  /** Explicit end. The room dies now and the code is refused forever after. */
  end(code: string, now: number): Room | null {
    const normalized = normalizeCode(code);
    const room = this.rooms.get(normalized);
    if (!room) return null;

    this.rooms.delete(normalized);
    this.tombstone(normalized, now);
    return room;
  }

  /**
   * Expire whatever is due. Returns the rooms that were destroyed and the seats that were
   * released, so the caller can notify the survivors.
   *
   * Called on every join and resume as well as on a timer, so a room cannot be found in an
   * expired-but-not-yet-swept state by a request that arrives between ticks.
   */
  /**
   * Everything swept since the last call, and clears it.
   *
   * Exists because sweep() is called from several places that only want its SIDE EFFECT:
   * join, resume, and the host presence check all sweep so they do not read stale state, and
   * all of them discard what it returns. That was survivable while a released seat only meant
   * "tell the peer", and became a silent failure the moment an expiring HOST had to end the
   * room: whichever of those happened to sweep first consumed the expiry, the socket layer's
   * own sweep found nothing, and the room was left with a guest in it, unendable and
   * unjoinable. Security review reproduced exactly that over real sockets.
   *
   * Queuing instead of returning means it does not matter who triggers a sweep. The events wait
   * until the layer that knows how to announce them drains the queue.
   */
  takeSwept(): { destroyed: Room[]; released: Array<{ room: Room; member: Member }> } {
    const taken = this.swept;
    this.swept = { destroyed: [], released: [] };
    return taken;
  }

  sweep(now: number): { destroyed: Room[]; released: Array<{ room: Room; member: Member }> } {
    const destroyed: Room[] = [];
    const released: Array<{ room: Room; member: Member }> = [];
    // See takeSwept. Everything found here is ALSO queued, so a caller that ignores the return
    // value cannot swallow the event.

    for (const [code, room] of this.rooms) {
      // Release expired seats first: doing it after the destroy check would let a room with
      // only expired members survive a tick.
      const expired = room.members.filter(
        (m) => !m.connected && m.reconnectDeadline !== null && m.reconnectDeadline <= now,
      );
      for (const member of expired) {
        room.members = room.members.filter((m) => m.id !== member.id);
        released.push({ room, member });
      }
      if (expired.length > 0 && room.members.length === 0 && room.destroyDeadline === null) {
        this.armDestroy(room, now);
      }

      if (room.destroyDeadline !== null && room.destroyDeadline <= now) {
        this.rooms.delete(code);
        this.tombstone(code, now);
        destroyed.push(room);
      }
    }

    for (const [code, expiresAt] of this.tombstones) {
      if (expiresAt <= now) this.tombstones.delete(code);
    }

    // Queued as well as returned. A caller that ignores the return value still cannot lose an
    // event: it waits here until the socket layer drains it.
    this.swept.destroyed.push(...destroyed);
    this.swept.released.push(...released);
    return { destroyed, released };
  }

  private armDestroy(room: Room, now: number): void {
    // Guard against re-arming. Two members leaving in the same tick would otherwise push the
    // deadline out on the second call and give the room longer than the grace window.
    if (room.destroyDeadline === null) room.destroyDeadline = now + GRACE_MS;
  }

  private tombstone(code: string, now: number): void {
    if (this.tombstones.size >= TOMBSTONE_MAX) {
      // FIFO eviction. Map preserves insertion order, so the oldest key is the first one.
      const oldest = this.tombstones.keys().next();
      if (!oldest.done) this.tombstones.delete(oldest.value);
    }
    this.tombstones.set(code, now + TOMBSTONE_TTL_MS);
  }

  private allocateCode(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = generateCode();
      if (!this.rooms.has(code) && !this.tombstones.has(code)) return code;
    }
    // At 40 bits with fewer than 10,000 live rooms, ten collisions in a row is not luck, it is
    // a bug in the generator. Failing loudly beats silently reusing a live or tombstoned code.
    throw new Error("could not allocate an unused room code in 10 attempts");
  }
}
