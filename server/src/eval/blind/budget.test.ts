// The run budget is read off the ledger and reserves the worst case of every call in flight.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROGRAMS } from "../../spend/caps.js";
import { append, entry, ledgerPath } from "../../spend/ledger.js";
import { RunBudget } from "./budget.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "blind-budget-"));
  roots.push(root);
  mkdirSync(join(root, "out", "translatv"), { recursive: true });
  writeFileSync(ledgerPath(root), "", "utf8");
  return root;
}

const RUN = "run0000000000001";

function spend(root: string, options: { room?: string; program?: string; model?: string; inputTokens?: number; outputTokens?: number; worstCaseUsd?: number }) {
  append(
    entry({
      program: options.program ?? PROGRAMS.blindTest,
      kind: "eval",
      model: options.model ?? "claude-haiku-4-5",
      room: options.room ?? RUN,
      ...(options.worstCaseUsd !== undefined
        ? { worstCaseUsd: options.worstCaseUsd }
        : { inputTokens: options.inputTokens ?? 1_000_000, outputTokens: options.outputTokens ?? 0 }),
    }),
    root,
  );
}

describe("RunBudget", () => {
  it("counts only this run's blind-test rows, unknown costs at their worst case", () => {
    const root = ledgerRoot();
    spend(root, { inputTokens: 1_000_000 }); // $1.00
    spend(root, { worstCaseUsd: 0.25 });
    spend(root, { room: "another-run", inputTokens: 1_000_000 });
    spend(root, { program: PROGRAMS.runtimeTranslation, inputTokens: 1_000_000 });
    spend(root, { model: "claude-sonnet-5-5", inputTokens: 100_000 }); // $0.20
    const budget = new RunBudget(root, RUN, 6, 4, "claude-sonnet-5-5");
    expect(budget.spent()).toEqual({ totalUsd: 1.45, judgeUsd: 0.2, worstCaseRows: 1 });
  });

  it("refuses a call whose worst case, with what is spent and what is in flight, would pass the budget", () => {
    const root = ledgerRoot();
    spend(root, { inputTokens: 1_000_000 }); // $1.00 of a $2.00 budget
    const budget = new RunBudget(root, RUN, 2, 1, "claude-sonnet-5-5");
    const first = budget.reserve(0.6, false);
    expect(first.ok).toBe(true);
    // 1.00 spent + 0.60 in flight + 0.50 is 2.10: refused, though the ledger alone says 1.00.
    const second = budget.reserve(0.5, false);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/run budget of \$2\.00/);
    // Exactly at the budget is allowed.
    expect(budget.reserve(0.4, false).ok).toBe(true);
    // Released, its headroom comes back: 1.00 + 0.40 + 0.60 fits, 0.61 more would not.
    if (first.ok) budget.release(first.reservation);
    expect(budget.reserve(0.61, false).ok).toBe(false);
    expect(budget.reserve(0.6, false).ok).toBe(true);
  });

  it("reads the ledger, not memory: a row appended by anyone counts at the next check", () => {
    const root = ledgerRoot();
    const budget = new RunBudget(root, RUN, 2, 1, "claude-sonnet-5-5");
    expect(budget.reserve(1.5, false).ok).toBe(true);
    const fresh = new RunBudget(root, RUN, 2, 1, "claude-sonnet-5-5");
    spend(root, { inputTokens: 1_900_000 }); // $1.90
    fresh.invalidate();
    expect(fresh.reserve(0.2, false).ok).toBe(false);
    expect(fresh.reserve(0.1, false).ok).toBe(true);
  });

  it("holds the judge to its own sub budget, inside the total", () => {
    const root = ledgerRoot();
    spend(root, { model: "claude-sonnet-5-5", inputTokens: 400_000 }); // $0.80 of judge
    const budget = new RunBudget(root, RUN, 6, 1, "claude-sonnet-5-5");
    expect(budget.reserve(0.3, true).ok).toBe(false);
    expect(budget.reserve(0.3, false).ok).toBe(true);
    expect(budget.reserve(0.2, true).ok).toBe(true);
  });

  it("refuses a call it cannot bound, and refuses when the ledger is gone", () => {
    const root = ledgerRoot();
    const budget = new RunBudget(root, RUN, 6, 4, "claude-sonnet-5-5");
    expect(budget.reserve(null, false).ok).toBe(false);
    rmSync(ledgerPath(root));
    budget.invalidate();
    const gone = budget.reserve(0.01, false);
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.reason).toMatch(/ledger is gone/);
  });
});
