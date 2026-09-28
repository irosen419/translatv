// The budget gate: the thing that actually stops money being spent.
//
// Every paid call goes through check() first. The answer is derived from the LEDGER ON DISK,
// not from a counter this process happens to be holding, because a counter dies with the
// process and a restart would silently reset the day's spend to zero. That is the exact shape
// of the awws failure this repo is set up not to repeat.
//
// Reading the file on every call would be wasteful once the ledger is long, so the parse is
// cached against the file's size and mtime. A change from any writer (this server, the nightly
// eval, a hand edit) invalidates it on the next stat, which costs a syscall rather than a read.
// Correctness against external writers is preserved; only the redundant parsing is skipped.
//
// A ledger that cannot be read is NOT treated as zero spend. LedgerNotFound propagates, and
// the caller's policy is to refuse the call rather than to spend blind. "No ledger" and "spent
// nothing" are different facts, and only one of them is safe to act on.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  LedgerNotFound,
  ledgerPath,
  load,
  PROJECT_SLUG,
  type SpendRecord,
} from "./ledger.js";
import { roundMoney } from "./pricing.js";

/** Programs a spend record can draw against. Runtime spend and autopilot spend are separate. */
export const PROGRAMS = {
  /** Live translation during a call. */
  runtimeTranslation: "runtime-translation",
  /** Proper noun harvesting, batched off the hot path. Shares the room cap. */
  runtimeTermExtraction: "runtime-term-extraction",
  /** Nightly translation quality evaluation. Armed by the owner, never automatically. */
  autopilotEval: "autopilot-eval",
  /**
   * script/verify_translation.mjs, the only thing here that spends against the live API by hand.
   *
   * Separate from runtimeTranslation for the reason HANDOFF-APP.md section 4 gives for benchmark
   * spend: about 25 calls of contrived probe text booked as runtime would move the runtime cost
   * per call figure that the ledger exists to report. It is real money either way and it belongs
   * in the real ledger, just not in that column.
   */
  verification: "verification",
} as const;

export interface CapConfig {
  /** Hard global ceiling per UTC day. On breach the app degrades, it does not break. */
  dailyCapUsd: number;
  /** Per room ceiling. Roughly three hours of continuous conversation at the default. */
  roomCapUsd: number;
}

export type CapDecision =
  | { allowed: true; dailySpentUsd: number; roomSpentUsd: number }
  | {
      allowed: false;
      reason: "daily_cap" | "room_cap" | "ledger_unreadable";
      dailySpentUsd: number | null;
      roomSpentUsd: number | null;
      message: string;
    };

interface CacheEntry {
  size: number;
  mtimeMs: number;
  records: SpendRecord[];
}

export class SpendGate {
  private cache: CacheEntry | null = null;

  constructor(
    private readonly root: string,
    private readonly config: CapConfig,
    private readonly project: string = PROJECT_SLUG,
  ) {}

  /**
   * Force the next check to re-read the ledger.
   *
   * Called right after this process appends, so a burst of calls inside one mtime granularity
   * window cannot reuse a stale parse and overshoot the cap. Filesystem mtime resolution is
   * coarser than our call rate, so relying on stat alone would be a real hole.
   */
  invalidate(): void {
    this.cache = null;
  }

  /**
   * Decide whether one more paid call is allowed.
   *
   * roomHash is the truncated sha256 the ledger stores, never the room code itself.
   */
  check(roomHash: string): CapDecision {
    let records: SpendRecord[];
    try {
      records = this.records();
    } catch (error) {
      if (error instanceof LedgerNotFound) {
        // Deliberately a refusal, not a pass. Spending against a cap we cannot see is the
        // failure mode the cap exists to prevent.
        return {
          allowed: false,
          reason: "ledger_unreadable",
          dailySpentUsd: null,
          roomSpentUsd: null,
          message:
            "spend ledger is missing, so spend to date is unknown. Refusing to spend " +
            "against a cap that cannot be read. Create the ledger, then retry.",
        };
      }
      throw error;
    }

    const today = new Date().toISOString().slice(0, 10);
    const dailySpentUsd = sum(records.filter((r) => dayOf(r) === today));
    const roomSpentUsd = sum(records.filter((r) => r.room === roomHash));

    if (dailySpentUsd >= this.config.dailyCapUsd) {
      return {
        allowed: false,
        reason: "daily_cap",
        dailySpentUsd,
        roomSpentUsd,
        message:
          `daily cap reached: $${dailySpentUsd.toFixed(4)} of ` +
          `$${this.config.dailyCapUsd.toFixed(2)} spent today`,
      };
    }

    if (roomSpentUsd >= this.config.roomCapUsd) {
      return {
        allowed: false,
        reason: "room_cap",
        dailySpentUsd,
        roomSpentUsd,
        message:
          `room cap reached: $${roomSpentUsd.toFixed(4)} of ` +
          `$${this.config.roomCapUsd.toFixed(2)} spent in this room`,
      };
    }

    return { allowed: true, dailySpentUsd, roomSpentUsd };
  }

  /**
   * The cap in force for a program, for stamping onto a record's cap_usd.
   *
   * verification lands on the room cap with the runtime programs, and that is deliberate rather
   * than incidental: one verification run uses one room hash, so the room cap IS its whole
   * ceiling, which is the same relationship a real conversation has to it. autopilotEval is the
   * exception because a nightly eval is bounded by the day, not by a room.
   */
  capFor(program: string): number {
    return program === PROGRAMS.autopilotEval
      ? this.config.dailyCapUsd
      : this.config.roomCapUsd;
  }

  private records(): SpendRecord[] {
    const path = ledgerPath(this.root, this.project);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new LedgerNotFound(path);
    }

    if (
      this.cache !== null &&
      this.cache.size === stat.size &&
      this.cache.mtimeMs === stat.mtimeMs
    ) {
      return this.cache.records;
    }

    const records = load({ root: this.root, project: this.project });
    this.cache = { size: stat.size, mtimeMs: stat.mtimeMs, records };
    return records;
  }
}

/**
 * The record's UTC calendar day, or null when it has no readable timestamp.
 *
 * Parsing is strict. A record with an unreadable ts is UNDATED and therefore counts toward no
 * day, which is deliberate: coercing it into today would invent a spike and make the daily cap
 * fire against spend that did not happen today.
 */
function dayOf(record: SpendRecord): string | null {
  if (!record.ts) return null;
  const parsed = new Date(record.ts);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Sum of recovered costs, with a call whose cost is unknown counted at its worst case.
 *
 * A null cost with no worst case still contributes nothing, which is correct for a floor but
 * means a cap can be approached without a gate noticing when rows are unparsed. That is why the
 * ledger refuses an inconsistent cost at write time rather than storing it: keeping unparsed rows
 * near zero is what makes this sum trustworthy. A call that timed out or lost its connection may
 * still have been billed, so its row carries the most it could have cost, and that is what counts
 * here (owner decision, 2026-09-28): the cap is spent on the pessimistic figure, never the hopeful
 * one.
 */
function sum(records: SpendRecord[]): number {
  return roundMoney(
    records.reduce((total, r) => {
      if (typeof r.cost_usd === "number") return total + r.cost_usd;
      return total + (typeof r.worst_case_usd === "number" && r.worst_case_usd > 0 ? r.worst_case_usd : 0);
    }, 0),
  );
}

/**
 * Truncated sha256 of a room code, for correlating a room's spend without recording the code.
 *
 * 64 bits separates concurrent rooms in a ledger comfortably. What it does NOT do is put a code
 * beyond recovery, and this comment used to claim otherwise. A code is 8 characters over a 32
 * character alphabet, so 2^40 candidates: enumerating sha256 over that and matching the truncated
 * digest is minutes of ordinary GPU time, and this repository commits real hashes.
 *
 * So the honest claim is the narrow one. This keeps codes out of plaintext in files that get
 * committed, pasted into issues, and shipped to a dashboard. It is not a secret, and nothing
 * should be built on the assumption that it is. Rooms are in memory and die with the process,
 * and a full room refuses a third member, so a recovered historical code opens nothing; that is
 * the property doing the real work, not the hash.
 *
 * An HMAC keyed on a boot secret would make the strong claim true, at the cost of hashes no
 * longer being comparable across a restart. Not worth it for a value whose usefulness is
 * correlation.
 */
export function roomHash(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}
