// Tests for the budget gate.
//
// The behaviors that matter most here are the refusals: a gate that fails open is worse than
// no gate, because it reads as protection while providing none.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROGRAMS, roomHash, SpendGate } from "./caps.js";
import { append, entry } from "./ledger.js";

const CONFIG = { dailyCapUsd: 1.0, roomCapUsd: 0.5, userDailyCapUsd: 0.3 };
const ROOM = roomHash("TESTROOM");
// Opaque account ids, the shape store/users.ts mints (16 random bytes, base64url). Never an email.
const HOST = "hostAccount00000000000A";
const OTHER_HOST = "hostAccount00000000000B";

describe("SpendGate", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "caps-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function seedEmptyLedger(project = "gate"): void {
    mkdirSync(join(root, "out", project), { recursive: true });
    writeFileSync(join(root, "out", project, "spend_log.jsonl"), "", "utf8");
  }

  function spend(
    dollars: number,
    room: string | null,
    project = "gate",
    ts?: string,
    userId: string | null = null,
  ): void {
    append(
      {
        ...entry({
          program: PROGRAMS.runtimeTranslation,
          kind: "translation",
          model: "claude-haiku-4-5",
          room,
          userId,
          project,
          capUsd: CONFIG.roomCapUsd,
          ...(ts ? { ts } : {}),
        }),
        // Set the cost directly: these tests are about the gate's arithmetic, not the price
        // table's, and entry() would refuse a cost inconsistent with absent token counts.
        cost_usd: dollars,
        cost_source: "logged" as const,
      },
      root,
    );
  }

  it("REFUSES when the ledger is missing rather than reading it as zero spend", () => {
    // The most important case. Spending against a cap that cannot be read is exactly the
    // failure the cap exists to prevent, so an unreadable ledger is a refusal, not a pass.
    const gate = new SpendGate(root, CONFIG, "never-created");
    const decision = gate.check(ROOM, null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("ledger_unreadable");
      expect(decision.dailySpentUsd).toBeNull();
    }
  });

  it("allows a call against an empty ledger", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    expect(gate.check(ROOM, null).allowed).toBe(true);
  });

  it("blocks once the room cap is reached", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.5, ROOM);
    gate.invalidate();

    const decision = gate.check(ROOM, null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("room_cap");
  });

  it("does not let one room's spend block a different room", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.5, ROOM);
    gate.invalidate();
    expect(gate.check(roomHash("OTHERROOM"), null).allowed).toBe(true);
  });

  it("blocks every room once the daily cap is reached", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    // Spread across rooms so no single room cap fires first.
    spend(0.4, roomHash("A"));
    spend(0.4, roomHash("B"));
    spend(0.4, roomHash("C"));
    gate.invalidate();

    const decision = gate.check(roomHash("D"), null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
  });

  it("counts only today toward the daily cap", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.9, roomHash("A"), "gate", "2020-01-01T00:00:00.000Z");
    gate.invalidate();
    // Yesterday's spend is real money but it is not today's, so the daily gate must not fire.
    expect(gate.check(roomHash("B"), null).allowed).toBe(true);
  });

  it("does not count an undated record toward any day", () => {
    // Coercing an unreadable ts into today would invent a spike and fire the daily cap against
    // spend that did not happen today.
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    append(
      {
        ...entry({
          program: PROGRAMS.runtimeTranslation,
          kind: "translation",
          model: "claude-haiku-4-5",
          room: roomHash("A"),
          project: "gate",
          ts: null,
        }),
        cost_usd: 5.0,
        cost_source: "logged" as const,
      },
      root,
    );
    gate.invalidate();
    expect(gate.check(roomHash("B"), null).allowed).toBe(true);
  });

  it("survives a restart, because it reads the ledger and not a counter", () => {
    // A fresh gate object is what a restarted process looks like. If spend lived in memory,
    // this would wrongly allow the call and the day's budget would reset on every deploy.
    seedEmptyLedger();
    spend(0.4, roomHash("A"));
    spend(0.4, roomHash("B"));
    spend(0.4, roomHash("C"));

    const afterRestart = new SpendGate(root, CONFIG, "gate");
    const decision = afterRestart.check(roomHash("D"), null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
  });

  it("picks up an external writer's rows after invalidation", () => {
    // The nightly eval writes to the same ledger while the server runs.
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    expect(gate.check(ROOM, null).allowed).toBe(true);

    spend(0.6, ROOM);
    gate.invalidate();
    expect(gate.check(ROOM, null).allowed).toBe(false);
  });

  describe("the per user daily cap", () => {
    it("REFUSES once this user's day is spent, although the global and room caps have room", () => {
      // Spread across rooms so no room cap is anywhere near, and well under the global cap.
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.15, roomHash("A"), "gate", undefined, HOST);
      spend(0.15, roomHash("B"), "gate", undefined, HOST);
      gate.invalidate();

      const decision = gate.check(roomHash("C"), HOST);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("user_cap");
        expect(decision.userSpentUsd).toBeCloseTo(0.3, 9);
        expect(decision.dailySpentUsd).toBeCloseTo(0.3, 9);
        expect(decision.roomSpentUsd).toBe(0);
      }
    });

    it("does not let one user's spend block a different user", () => {
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.3, roomHash("A"), "gate", undefined, HOST);
      gate.invalidate();
      const decision = gate.check(roomHash("B"), OTHER_HOST);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.userSpentUsd).toBe(0);
    });

    it("counts only this user's spend from TODAY", () => {
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.29, roomHash("A"), "gate", "2020-01-01T00:00:00.000Z", HOST);
      gate.invalidate();
      expect(gate.check(roomHash("B"), HOST).allowed).toBe(true);
    });

    it("never counts an unattributed row toward any user", () => {
      // Rows written before user_id existed carry no key at all. They are real spend and still
      // count toward the global and room caps, but attributing them to whoever asks next would
      // charge a user for money somebody else spent.
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.29, roomHash("A"), "gate", undefined, null);
      spend(0.29, roomHash("B"), "gate", undefined, null);
      gate.invalidate();
      const decision = gate.check(roomHash("C"), HOST);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.userSpentUsd).toBe(0);
        expect(decision.dailySpentUsd).toBeCloseTo(0.58, 9);
      }
    });

    it("never allows what the GLOBAL daily cap refuses, however little the user has spent", () => {
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.4, roomHash("A"), "gate", undefined, OTHER_HOST);
      spend(0.4, roomHash("B"), "gate", undefined, null);
      spend(0.4, roomHash("C"), "gate", undefined, null);
      gate.invalidate();

      const decision = gate.check(roomHash("D"), HOST);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
    });

    it("never allows what the ROOM cap refuses, however little the user has spent", () => {
      // A generous user cap must not loosen a tight room cap: all three have to pass.
      seedEmptyLedger();
      const loose = new SpendGate(root, { ...CONFIG, userDailyCapUsd: 100 }, "gate");
      spend(0.5, ROOM, "gate", undefined, null);
      loose.invalidate();

      const decision = loose.check(ROOM, HOST);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("room_cap");
    });

    it("never allows what the global cap refuses even with a user cap far above it", () => {
      seedEmptyLedger();
      const loose = new SpendGate(root, { ...CONFIG, userDailyCapUsd: 100 }, "gate");
      spend(0.45, roomHash("A"), "gate", undefined, HOST);
      spend(0.45, roomHash("B"), "gate", undefined, HOST);
      spend(0.45, roomHash("C"), "gate", undefined, HOST);
      loose.invalidate();

      const decision = loose.check(roomHash("D"), HOST);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
    });

    it("still REFUSES a missing ledger when a user is named", () => {
      const gate = new SpendGate(root, CONFIG, "never-created");
      const decision = gate.check(ROOM, HOST);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe("ledger_unreadable");
        expect(decision.userSpentUsd).toBeNull();
      }
    });

    it("applies the global and room caps, and no user cap, to an unattributed call", () => {
      // Verification and eval spend belongs to no account. Leaving the user cap out for them is
      // not a loophole: the other two caps still bind, and they are the ones that bound every
      // call before this cap existed.
      seedEmptyLedger();
      const gate = new SpendGate(root, CONFIG, "gate");
      spend(0.3, roomHash("A"), "gate", undefined, HOST);
      gate.invalidate();
      const decision = gate.check(roomHash("B"), null);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.userSpentUsd).toBeNull();

      spend(0.5, roomHash("B"), "gate", undefined, null);
      gate.invalidate();
      const refused = gate.check(roomHash("B"), null);
      expect(refused.allowed).toBe(false);
      if (!refused.allowed) expect(refused.reason).toBe("room_cap");
    });
  });

  it("reports the caps in force per program", () => {
    const gate = new SpendGate(root, CONFIG, "gate");
    expect(gate.capFor(PROGRAMS.runtimeTranslation)).toBe(CONFIG.roomCapUsd);
    expect(gate.capFor(PROGRAMS.autopilotEval)).toBe(CONFIG.dailyCapUsd);
    // Verification takes the ROOM cap, and that is a decision rather than a fallthrough: one
    // verification run uses one room hash, so the room cap is its entire ceiling. Asserted so a
    // later reader cannot mistake it for a program nobody thought about.
    expect(gate.capFor(PROGRAMS.verification)).toBe(CONFIG.roomCapUsd);
  });
});

describe("roomHash", () => {
  it("is stable for the same code", () => {
    expect(roomHash("ABC123")).toBe(roomHash("ABC123"));
  });

  it("differs for different codes", () => {
    expect(roomHash("ABC123")).not.toBe(roomHash("ABC124"));
  });

  it("does not contain the code itself", () => {
    // The ledger is committed, so a reader of git history must not be able to recover a room
    // code from it and join a call.
    expect(roomHash("ABC123")).not.toContain("ABC123");
  });
});
