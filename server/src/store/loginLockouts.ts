// The login_lockouts table: consecutive failed logins per account, keyed by a keyed hash of the
// normalized email (see migration 5 for why it is not the user id).

import type { Store } from "./store.js";

export interface LockoutRow {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number | null;
}

export function findLockout(store: Store, emailHash: string): LockoutRow | null {
  const row = store.db.prepare("SELECT * FROM login_lockouts WHERE email_hash = ?").get(emailHash);
  if (!row) return null;
  return {
    failures: Number(row["failures"]),
    lastFailureAt: Number(row["last_failure_at"]),
    lockedUntil: row["locked_until"] === null ? null : Number(row["locked_until"]),
  };
}

export function saveLockout(store: Store, emailHash: string, row: LockoutRow): void {
  store.db
    .prepare(
      `INSERT INTO login_lockouts (email_hash, failures, last_failure_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (email_hash) DO UPDATE SET
         failures = excluded.failures,
         last_failure_at = excluded.last_failure_at,
         locked_until = excluded.locked_until`,
    )
    .run(emailHash, row.failures, row.lastFailureAt, row.lockedUntil);
}

export function clearLockout(store: Store, emailHash: string): void {
  store.db.prepare("DELETE FROM login_lockouts WHERE email_hash = ?").run(emailHash);
}

/**
 * Forget rows with nothing left to enforce: no live lock, and no failure recent enough to still
 * count. Without this an attacker cycling through made up addresses would grow the table forever.
 */
export function pruneLockouts(store: Store, now: number, windowMs: number): number {
  const result = store.db
    .prepare(
      `DELETE FROM login_lockouts
        WHERE (locked_until IS NULL OR locked_until <= ?) AND last_failure_at <= ?`,
    )
    .run(now, now - windowMs);
  return Number(result.changes);
}
