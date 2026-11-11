// The blind test's spend gate: a hard budget for one run, read off the LEDGER.
//
// A run's spend is every ledger row under the blind-test program that carries the run's room hash
// (runRoom), costed as SpendGate costs a row: its cost, or, for a call whose cost nobody could
// recover, its worst case. Read from the file, not counted in memory, so a crash and a rerun with
// the same --run-id carry on against the same total, and so a row this process failed to append
// cannot be mistaken for money not spent: the run stops instead (BlindRun).
//
// Before each call: the run's spend so far, plus the worst case of every call still in flight,
// plus this call's worst case, must fit in the budget, or the call is not made. Reserving the in
// flight worst cases is what lets calls run concurrently with no overshoot at all: the check and
// the reservation happen together, synchronously, so no two calls can both see the same headroom.
// The judge has a sub budget, checked the same way over the judge's rows only, and still under the
// run's total.

import { statSync } from "node:fs";
import { PROGRAMS } from "../../spend/caps.js";
import { LedgerNotFound, ledgerPath, load, type SpendRecord } from "../../spend/ledger.js";
import { roundMoney } from "../../spend/pricing.js";

export interface Reservation {
  readonly worstCaseUsd: number;
  readonly judge: boolean;
}

export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: string };

export interface RunSpend {
  /** Everything this run has cost, unknown costs at their worst case. */
  totalUsd: number;
  /** The judge's part of it. */
  judgeUsd: number;
  /** Rows with no recoverable cost, counted at their worst case above. */
  worstCaseRows: number;
}

/** A row's money as a cap counts it: its cost, else its worst case, else nothing. */
export function rowUsd(record: SpendRecord): number {
  if (typeof record.cost_usd === "number") return record.cost_usd;
  return typeof record.worst_case_usd === "number" && record.worst_case_usd > 0 ? record.worst_case_usd : 0;
}

export class RunBudget {
  private readonly inFlight = new Set<Reservation>();
  private cache: { size: number; mtimeMs: number; records: SpendRecord[] } | null = null;

  constructor(
    private readonly root: string,
    private readonly runRoom: string,
    readonly totalUsd: number,
    readonly judgeUsd: number,
    private readonly judgeModel: string,
  ) {}

  /** Re-read the ledger on the next check. Called after every append this process makes. */
  invalidate(): void {
    this.cache = null;
  }

  /** This run's spend so far, from the ledger. Throws LedgerNotFound: never zero for no ledger. */
  spent(): RunSpend {
    let totalUsd = 0;
    let judgeUsd = 0;
    let worstCaseRows = 0;
    for (const record of this.records()) {
      if (record.program !== PROGRAMS.blindTest || record.room !== this.runRoom) continue;
      const usd = rowUsd(record);
      totalUsd += usd;
      if (record.model === this.judgeModel) judgeUsd += usd;
      if (typeof record.cost_usd !== "number") worstCaseRows += 1;
    }
    return { totalUsd: roundMoney(totalUsd), judgeUsd: roundMoney(judgeUsd), worstCaseRows };
  }

  /**
   * Reserve a call's worst case, or refuse it. Synchronous on purpose: see the header. A worst case
   * of null (a model with no documented price) is refused: a call nobody can bound cannot be fitted
   * in a budget.
   */
  reserve(worstCaseUsd: number | null, judge: boolean): ReserveResult {
    if (worstCaseUsd === null) return { ok: false, reason: "a call has no documented price, so it cannot be budgeted" };
    let spent: RunSpend;
    try {
      spent = this.spent();
    } catch (error) {
      if (error instanceof LedgerNotFound) return { ok: false, reason: "the ledger is gone, so this run's spend is unknown" };
      throw error;
    }
    const held = [...this.inFlight];
    const heldTotal = held.reduce((sum, r) => sum + r.worstCaseUsd, 0);
    const heldJudge = held.filter((r) => r.judge).reduce((sum, r) => sum + r.worstCaseUsd, 0);
    // Rounded as every figure here is, so a sum landing exactly on the budget is not refused over
    // floating point noise in the last place.
    if (roundMoney(spent.totalUsd + heldTotal + worstCaseUsd) > this.totalUsd) {
      return {
        ok: false,
        reason:
          `the run budget of $${this.totalUsd.toFixed(2)} would be exceeded: $${spent.totalUsd.toFixed(6)} spent, ` +
          `$${roundMoney(heldTotal).toFixed(6)} in flight at worst case, $${worstCaseUsd.toFixed(6)} for the next call`,
      };
    }
    if (judge && roundMoney(spent.judgeUsd + heldJudge + worstCaseUsd) > this.judgeUsd) {
      return {
        ok: false,
        reason:
          `the judge budget of $${this.judgeUsd.toFixed(2)} would be exceeded: $${spent.judgeUsd.toFixed(6)} spent, ` +
          `$${roundMoney(heldJudge).toFixed(6)} in flight at worst case, $${worstCaseUsd.toFixed(6)} for the next call`,
      };
    }
    const reservation: Reservation = { worstCaseUsd, judge };
    this.inFlight.add(reservation);
    return { ok: true, reservation };
  }

  /** Release a reservation, once the call's own row (if any) is on the ledger. */
  release(reservation: Reservation): void {
    this.inFlight.delete(reservation);
  }

  private records(): SpendRecord[] {
    const path = ledgerPath(this.root);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      throw new LedgerNotFound(path);
    }
    if (this.cache !== null && this.cache.size === stat.size && this.cache.mtimeMs === stat.mtimeMs) return this.cache.records;
    const records = load({ root: this.root });
    this.cache = { size: stat.size, mtimeMs: stat.mtimeMs, records };
    return records;
  }
}
