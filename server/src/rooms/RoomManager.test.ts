// Every row of the room lifecycle table, plus the edge cases that are not obvious.
//
// This is the highest value test suite in the project: the state machine is where the real bugs
// in this shape of app live, and because RoomManager takes an explicit `now` and touches no
// sockets, all of it is testable without fake timers or a running server.

import { describe, expect, it } from "vitest";
import { GRACE_MS, MAX_MEMBERS, RoomManager, TOMBSTONE_TTL_MS } from "./RoomManager.js";
import { ALPHABET, CODE_LENGTH, generateCode, isValidCode, normalizeCode } from "./codes.js";

const T0 = 1_000_000;

function withOne(now = T0) {
  const rooms = new RoomManager();
  const created = rooms.create("Ana", "es-AR", now, "user-ana");
  return { rooms, ...created };
}

describe("hasHostPresent", () => {
  it("answers about who is seated", () => {
    const rooms = new RoomManager();
    const { room } = rooms.create("Ana", "es-AR", T0, "user-ana");
    expect(rooms.hasHostPresent(room.code)).toBe(true);
    expect(rooms.hasHostPresent("ZZZZZZZZ")).toBe(false);
  });

  it("makes the creator the host and a joiner a guest", () => {
    const rooms = new RoomManager();
    const { room, member } = rooms.create("Ana", "es-AR", T0, "user-ana");
    const joined = rooms.join(room.code, "Ben", "en-US", T0, "user-ben");
    expect(member.isHost).toBe(true);
    expect(joined.ok && joined.member.isHost).toBe(false);
  });

  it("is false once only a guest is left", () => {
    const rooms = new RoomManager();
    const { room, member } = rooms.create("Ana", "es-AR", T0, "user-ana");
    rooms.join(room.code, "Ben", "en-US", T0, "user-ben");
    rooms.leave(room.code, member.id, T0);
    expect(rooms.hasHostPresent(room.code)).toBe(false);
  });

  it("still counts a host who has merely dropped", () => {
    // A held seat is presence. The grace window exists so a wifi hop does not cost the room.
    const rooms = new RoomManager();
    const { room, member } = rooms.create("Ana", "es-AR", T0, "user-ana");
    rooms.disconnect(room.code, member.id, T0);
    expect(rooms.hasHostPresent(room.code)).toBe(true);
  });

  // The regression that matters, and the one a WS level test cannot reach: the caller cannot
  // control the clock inside a join. This used to sweep internally and DISCARD the result, so
  // asking the question consumed the host's expiry. The caller's own sweep then found nothing
  // released, nothing ended the room, and the guest was stranded in a room that could not end
  // and that nobody could join.
  it("does not consume the expiry it is asked about", () => {
    const rooms = new RoomManager();
    const { room, member } = rooms.create("Ana", "es-AR", T0, "user-ana");
    rooms.join(room.code, "Ben", "en-US", T0, "user-ben");
    rooms.disconnect(room.code, member.id, T0);

    const expired = T0 + GRACE_MS + 1;
    // Ask first, exactly as a joining guest does.
    rooms.hasHostPresent(room.code);

    // The release must still be there to be reported. Asking a question may not swallow an event.
    const released = rooms.sweep(expired).released;
    expect(released.map((r) => r.member.id)).toContain(member.id);
  });
});

describe("hasEnded", () => {
  it("is true for an ended code and false for a live or unknown one", () => {
    const rooms = new RoomManager();
    const { room } = rooms.create("Ana", "es-AR", T0, "user-ana");
    expect(rooms.hasEnded(room.code)).toBe(false);
    expect(rooms.hasEnded("ZZZZZZZZ")).toBe(false);
    rooms.end(room.code, T0);
    expect(rooms.hasEnded(room.code)).toBe(true);
  });
});

describe("resume is tied to the account", () => {
  it("refuses a valid token presented by a different user, and leaves the seat alone", () => {
    const rooms = new RoomManager();
    const { room, member, resumeToken } = rooms.create("Ana", "es-AR", T0, "user-ana");
    rooms.disconnect(room.code, member.id, T0);

    expect(rooms.resume(room.code, resumeToken, T0 + 1, "user-mallory")).toEqual({
      ok: false,
      error: "INVALID_RESUME",
    });
    // The rightful owner's token was not rotated by the attempt, so it still works.
    const back = rooms.resume(room.code, resumeToken, T0 + 2, "user-ana");
    expect(back.ok).toBe(true);
  });
});

describe("capacity", () => {
  it("seats two", () => {
    const { rooms, room } = withOne();
    const second = rooms.join(room.code, "Ben", "en-US", T0);
    expect(second.ok).toBe(true);
    expect(room.members).toHaveLength(2);
  });

  it("refuses a third", () => {
    const { rooms, room } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    const third = rooms.join(room.code, "Cam", "en-US", T0);
    expect(third).toEqual({ ok: false, error: "ROOM_FULL" });
  });

  it("keeps a RECONNECTING member's seat against a stranger", () => {
    // The entire point of the per member deadline. A refresh must not hand your seat away.
    const { rooms, room, member } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    rooms.disconnect(room.code, member.id, T0);

    const stranger = rooms.join(room.code, "Cam", "en-US", T0 + 1_000);
    expect(stranger).toEqual({ ok: false, error: "ROOM_FULL" });
  });

  it("frees the seat once the reconnect window expires", () => {
    const { rooms, room, member } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    rooms.disconnect(room.code, member.id, T0);

    const released = rooms.sweep(T0 + GRACE_MS + 1).released;
    expect(released).toHaveLength(1);
    expect(released[0]?.member.id).toBe(member.id);

    const stranger = rooms.join(room.code, "Cam", "en-US", T0 + GRACE_MS + 2);
    expect(stranger.ok).toBe(true);
  });
});

describe("leave", () => {
  it("frees the seat IMMEDIATELY with no grace", () => {
    // Leaving is a decision, unlike a dropped connection. Holding the seat would make the room
    // look full to the friend the code was just sent to.
    const { rooms, room, member } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    rooms.leave(room.code, member.id, T0);

    expect(room.members).toHaveLength(1);
    const replacement = rooms.join(room.code, "Cam", "en-US", T0 + 1);
    expect(replacement.ok).toBe(true);
  });

  it("keeps the room alive while someone is still inside", () => {
    const { rooms, room, member } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    rooms.leave(room.code, member.id, T0);

    rooms.sweep(T0 + GRACE_MS * 5);
    expect(rooms.peek(room.code)).not.toBeNull();
  });

  it("arms the destroy window when the last member leaves", () => {
    const { rooms, room, member } = withOne();
    rooms.leave(room.code, member.id, T0);
    expect(room.destroyDeadline).toBe(T0 + GRACE_MS);
  });
});

describe("the empty room grace window", () => {
  it("stays joinable during the window", () => {
    const { rooms, room, member } = withOne();
    rooms.leave(room.code, member.id, T0);

    const rejoin = rooms.join(room.code, "Ben", "en-US", T0 + GRACE_MS - 1);
    expect(rejoin.ok).toBe(true);
  });

  it("is destroyed after the window", () => {
    const { rooms, room, member } = withOne();
    rooms.leave(room.code, member.id, T0);

    const { destroyed } = rooms.sweep(T0 + GRACE_MS + 1);
    expect(destroyed).toHaveLength(1);
    expect(rooms.peek(room.code)).toBeNull();
  });

  it("measures the window from when the room actually emptied", () => {
    // Two members leaving at different times: the window runs from the SECOND departure, which
    // is when the room became unoccupied, not from the first.
    const { rooms, room, member } = withOne();
    const second = rooms.join(room.code, "Ben", "en-US", T0);
    if (!second.ok) throw new Error("join failed");

    rooms.leave(room.code, member.id, T0);
    expect(room.destroyDeadline).toBeNull(); // still occupied

    rooms.leave(room.code, second.member.id, T0 + 5);
    expect(room.destroyDeadline).toBe(T0 + 5 + GRACE_MS);
  });

  it("does not push the deadline out on a later sweep", () => {
    // The re-arm guard. Without it, every sweep while the room sits empty would refresh the
    // deadline and the room would live forever, which is the kind of drift nobody notices
    // until a room outlives the call that created it.
    const { rooms, room, member } = withOne();
    rooms.leave(room.code, member.id, T0);
    const armedAt = room.destroyDeadline;

    rooms.sweep(T0 + 1_000);
    rooms.sweep(T0 + 2_000);
    expect(room.destroyDeadline).toBe(armedAt);

    rooms.sweep(T0 + GRACE_MS + 1);
    expect(rooms.peek(room.code)).toBeNull();
  });

  it("clears the destroy window when someone rejoins", () => {
    const { rooms, room, member } = withOne();
    rooms.leave(room.code, member.id, T0);
    rooms.join(room.code, "Ben", "en-US", T0 + 100);

    expect(room.destroyDeadline).toBeNull();
    rooms.sweep(T0 + GRACE_MS + 1);
    expect(rooms.peek(room.code)).not.toBeNull();
  });
});

describe("resume", () => {
  it("reclaims a seat and clears BOTH deadlines", () => {
    const { rooms, room, member, resumeToken } = withOne();
    rooms.disconnect(room.code, member.id, T0);
    expect(room.destroyDeadline).not.toBeNull();

    const resumed = rooms.resume(room.code, resumeToken, T0 + 1_000);
    expect(resumed.ok).toBe(true);
    expect(room.destroyDeadline).toBeNull();
    expect(member.reconnectDeadline).toBeNull();
    expect(member.connected).toBe(true);
  });

  it("survives a refresh by the LAST person in the room", () => {
    // The specific scenario the room grace window exists for: alone in the room, hit F5.
    const { rooms, room, member, resumeToken } = withOne();
    rooms.disconnect(room.code, member.id, T0);
    rooms.sweep(T0 + 500);

    const resumed = rooms.resume(room.code, resumeToken, T0 + 1_000);
    expect(resumed.ok).toBe(true);
  });

  it("REFUSES a wrong token rather than seating a new member", () => {
    // A silent fallback to a fresh join would look friendlier and would be a seat stealing bug:
    // anyone with the code could send junk and be quietly seated.
    const { rooms, room, member } = withOne();
    rooms.disconnect(room.code, member.id, T0);

    const resumed = rooms.resume(room.code, "not-the-token", T0 + 1_000);
    expect(resumed).toEqual({ ok: false, error: "INVALID_RESUME" });
    expect(room.members).toHaveLength(1);
  });

  it("rotates the token, so a captured one cannot be replayed", () => {
    const { rooms, room, member, resumeToken } = withOne();
    rooms.disconnect(room.code, member.id, T0);

    const first = rooms.resume(room.code, resumeToken, T0 + 100);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.resumeToken).not.toBe(resumeToken);

    rooms.disconnect(room.code, member.id, T0 + 200);
    const replay = rooms.resume(room.code, resumeToken, T0 + 300);
    expect(replay).toEqual({ ok: false, error: "INVALID_RESUME" });
  });

  it("evicts the older connection when a second tab claims the same token", () => {
    // Last writer wins, so a zombie tab cannot hold a seat its owner is trying to reclaim.
    const { rooms, room, member, resumeToken } = withOne();
    const resumed = rooms.resume(room.code, resumeToken, T0 + 100);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.evicted).toBe(member.id);
  });

  it("refuses to resume into an ended room", () => {
    const { rooms, room, resumeToken } = withOne();
    rooms.end(room.code, T0);
    expect(rooms.resume(room.code, resumeToken, T0 + 100)).toEqual({
      ok: false,
      error: "ROOM_ENDED",
    });
  });
});

describe("end", () => {
  it("destroys the room immediately", () => {
    const { rooms, room } = withOne();
    rooms.end(room.code, T0);
    expect(rooms.peek(room.code)).toBeNull();
    expect(rooms.size).toBe(0);
  });

  it("refuses the code afterwards with ROOM_ENDED, not ROOM_NOT_FOUND", () => {
    // A different message is better UX: "that chat was ended" versus "no such room" tells the
    // person whether they mistyped or arrived too late.
    const { rooms, room } = withOne();
    rooms.end(room.code, T0);
    expect(rooms.join(room.code, "Cam", "en-US", T0 + 1)).toEqual({
      ok: false,
      error: "ROOM_ENDED",
    });
  });

  it("returns the room so survivors can be notified", () => {
    const { rooms, room } = withOne();
    rooms.join(room.code, "Ben", "en-US", T0);
    const ended = rooms.end(room.code, T0);
    expect(ended?.members).toHaveLength(2);
  });

  it("expires the tombstone eventually", () => {
    // "Forever" is bounded by process lifetime and the TTL. Saying so beats claiming an
    // eternity the process cannot deliver.
    const { rooms, room } = withOne();
    rooms.end(room.code, T0);
    rooms.sweep(T0 + TOMBSTONE_TTL_MS + 1);
    expect(rooms.tombstoneCount).toBe(0);
  });
});

describe("lookup failures", () => {
  it("distinguishes a malformed code from a missing room", () => {
    const rooms = new RoomManager();
    expect(rooms.join("nope", "A", "en-US", T0)).toEqual({ ok: false, error: "BAD_CODE" });
    expect(rooms.join("ZZZZZZZZ", "A", "en-US", T0)).toEqual({
      ok: false,
      error: "ROOM_NOT_FOUND",
    });
  });
});

describe("no leaks", () => {
  it("leaves nothing behind after every terminal path", () => {
    const rooms = new RoomManager();

    const a = rooms.create("A", "en-US", T0);
    rooms.end(a.room.code, T0);

    const b = rooms.create("B", "en-US", T0);
    rooms.leave(b.room.code, b.member.id, T0);

    const c = rooms.create("C", "en-US", T0);
    rooms.disconnect(c.room.code, c.member.id, T0);

    rooms.sweep(T0 + GRACE_MS + 1);
    expect(rooms.size).toBe(0);

    // Each tombstone expires TTL after IT was created, and the two rooms destroyed by the
    // sweep above were tombstoned at T0 + GRACE_MS + 1, not at T0. Sweeping at T0 + TTL would
    // clear only the first and leave the other two, so the clock has to clear the latest one.
    rooms.sweep(T0 + GRACE_MS + TOMBSTONE_TTL_MS + 2);
    expect(rooms.tombstoneCount).toBe(0);
  });

  it("sweeps a room whose only members all expired in one tick", () => {
    // Releasing seats and checking for destruction in the wrong order would let a room with
    // only expired members survive a tick, and then survive forever because the next tick sees
    // no members to expire.
    const { rooms, room, member } = withOne();
    const second = rooms.join(room.code, "Ben", "en-US", T0);
    if (!second.ok) throw new Error("join failed");

    rooms.disconnect(room.code, member.id, T0);
    rooms.disconnect(room.code, second.member.id, T0);

    rooms.sweep(T0 + GRACE_MS + 1);
    expect(room.members).toHaveLength(0);
    rooms.sweep(T0 + GRACE_MS * 2 + 2);
    expect(rooms.peek(room.code)).toBeNull();
  });
});

describe("perfect negotiation roles", () => {
  it("makes the creator impolite and the joiner polite", () => {
    // Fixing the roles at creation is what stops both peers being polite and deadlocking, or
    // both being impolite and glaring on an offer collision.
    const { rooms, room, member } = withOne();
    const second = rooms.join(room.code, "Ben", "en-US", T0);
    expect(member.polite).toBe(false);
    if (second.ok) expect(second.member.polite).toBe(true);
  });
});

describe("codes", () => {
  it("is 8 characters from the Crockford alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect([...code].every((c) => ALPHABET.includes(c))).toBe(true);
    }
  });

  it("excludes the characters people mishear when reading aloud", () => {
    // I/1, L/1, O/0 are the pairs that get misheard, and U is excluded by Crockford.
    expect(ALPHABET).not.toContain("I");
    expect(ALPHABET).not.toContain("L");
    expect(ALPHABET).not.toContain("O");
    expect(ALPHABET).not.toContain("U");
  });

  it("normalizes what a human actually types", () => {
    expect(normalizeCode("abc-def12")).toBe("ABCDEF12");
    expect(normalizeCode(" hjkm npqr ")).toBe("HJKMNPQR");
    // The lookalike folds: O to zero, I and L to one, U to V.
    expect(normalizeCode("OILU")).toBe("011V");
    expect(normalizeCode("o0i1l")).toBe("00111");
  });

  it("resolves a mistyped O to the same room as a zero", () => {
    const rooms = new RoomManager();
    const { room } = rooms.create("A", "en-US", T0);
    const typo = room.code.replace(/0/g, "O").replace(/1/g, "I");
    expect(normalizeCode(typo)).toBe(room.code);
  });

  it("validates round trip", () => {
    for (let i = 0; i < 50; i += 1) expect(isValidCode(generateCode())).toBe(true);
    expect(isValidCode("short")).toBe(false);
    expect(isValidCode("!!!!!!!!")).toBe(false);
  });

  it("does not collide across many allocations", () => {
    const rooms = new RoomManager();
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const { room } = rooms.create("x", "en-US", T0);
      expect(seen.has(room.code)).toBe(false);
      seen.add(room.code);
    }
  });
});

describe("configuration", () => {
  it("caps a room at two", () => {
    expect(MAX_MEMBERS).toBe(2);
  });
});

describe("member preference defaults", () => {
  // One expectation object used against BOTH construction sites. The creator and the joiner are
  // built by separate literals, and separate literals drift: the whole point of asserting them
  // against a single constant is that adding a field to one and forgetting the other fails here
  // rather than becoming a bug that only affects people who joined rather than created.
  const DEFAULTS = { micEnabled: true, cameraEnabled: false, wantsTranslation: true };

  it("gives the creator the documented defaults", () => {
    const { member } = withOne();
    expect({
      micEnabled: member.micEnabled,
      cameraEnabled: member.cameraEnabled,
      wantsTranslation: member.wantsTranslation,
    }).toEqual(DEFAULTS);
  });

  it("gives a joiner exactly the same defaults", () => {
    const { rooms, room } = withOne();
    const joined = rooms.join(room.code, "Ben", "en-US", T0);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect({
      micEnabled: joined.member.micEnabled,
      cameraEnabled: joined.member.cameraEnabled,
      wantsTranslation: joined.member.wantsTranslation,
    }).toEqual(DEFAULTS);
  });

  // The reason these live on the server Member rather than in a side map: resume mutates the
  // member in place, so a preference someone set before a refresh is still theirs afterwards.
  // If it reset, a refresh would silently switch translation back on and resume spending.
  it("keeps a changed preference across a resume", () => {
    const { rooms, room, member, resumeToken } = withOne();
    member.wantsTranslation = false;
    member.micEnabled = false;

    rooms.disconnect(room.code, member.id, T0);
    const resumed = rooms.resume(room.code, resumeToken, T0 + 1_000);

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.member.wantsTranslation).toBe(false);
    expect(resumed.member.micEnabled).toBe(false);
    expect(resumed.member.connected).toBe(true);
  });

  // Deliberate, and worth pinning so nobody "fixes" it later without deciding to: leaving
  // removes the member, so a rejoin is a new seat with fresh defaults. Someone who turns
  // translation off, leaves by accident, and comes back is spending again. There is no
  // persistence in this app to prevent that, so the UI has to make the state visible instead.
  it("returns to defaults after leaving and rejoining", () => {
    const { rooms, room, member } = withOne();
    member.wantsTranslation = false;

    rooms.leave(room.code, member.id, T0);
    const rejoined = rooms.join(room.code, "Ana", "es-AR", T0);

    expect(rejoined.ok).toBe(true);
    if (!rejoined.ok) return;
    expect(rejoined.member.wantsTranslation).toBe(true);
  });
});
