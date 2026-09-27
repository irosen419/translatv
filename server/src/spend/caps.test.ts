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

const CONFIG = { dailyCapUsd: 1.0, roomCapUsd: 0.5 };
const ROOM = roomHash("TESTROOM");

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

  function spend(dollars: number, room: string | null, project = "gate", ts?: string): void {
    append(
      {
        ...entry({
          program: PROGRAMS.runtimeTranslation,
          kind: "translation",
          model: "claude-haiku-4-5",
          room,
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
    const decision = gate.check(ROOM);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("ledger_unreadable");
      expect(decision.dailySpentUsd).toBeNull();
    }
  });

  it("allows a call against an empty ledger", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    expect(gate.check(ROOM).allowed).toBe(true);
  });

  it("blocks once the room cap is reached", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.5, ROOM);
    gate.invalidate();

    const decision = gate.check(ROOM);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("room_cap");
  });

  it("does not let one room's spend block a different room", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.5, ROOM);
    gate.invalidate();
    expect(gate.check(roomHash("OTHERROOM")).allowed).toBe(true);
  });

  it("blocks every room once the daily cap is reached", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    // Spread across rooms so no single room cap fires first.
    spend(0.4, roomHash("A"));
    spend(0.4, roomHash("B"));
    spend(0.4, roomHash("C"));
    gate.invalidate();

    const decision = gate.check(roomHash("D"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
  });

  it("counts only today toward the daily cap", () => {
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    spend(0.9, roomHash("A"), "gate", "2020-01-01T00:00:00.000Z");
    gate.invalidate();
    // Yesterday's spend is real money but it is not today's, so the daily gate must not fire.
    expect(gate.check(roomHash("B")).allowed).toBe(true);
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
    expect(gate.check(roomHash("B")).allowed).toBe(true);
  });

  it("survives a restart, because it reads the ledger and not a counter", () => {
    // A fresh gate object is what a restarted process looks like. If spend lived in memory,
    // this would wrongly allow the call and the day's budget would reset on every deploy.
    seedEmptyLedger();
    spend(0.4, roomHash("A"));
    spend(0.4, roomHash("B"));
    spend(0.4, roomHash("C"));

    const afterRestart = new SpendGate(root, CONFIG, "gate");
    const decision = afterRestart.check(roomHash("D"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe("daily_cap");
  });

  it("picks up an external writer's rows after invalidation", () => {
    // The nightly eval writes to the same ledger while the server runs.
    seedEmptyLedger();
    const gate = new SpendGate(root, CONFIG, "gate");
    expect(gate.check(ROOM).allowed).toBe(true);

    spend(0.6, ROOM);
    gate.invalidate();
    expect(gate.check(ROOM).allowed).toBe(false);
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
