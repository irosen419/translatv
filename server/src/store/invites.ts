// The invites table. Rows hold a sha256 of the normalized code, never the code itself.

import type { Store } from "./store.js";

export function insertInvite(
  store: Store,
  invite: { codeHash: string; createdBy: string | null; createdAt: number; expiresAt: number },
): void {
  store.db
    .prepare("INSERT INTO invites (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(invite.codeHash, invite.createdBy, invite.createdAt, invite.expiresAt);
}

/** Is there an unused, unexpired invite with this hash? Reads only. */
export function inviteIsUsable(store: Store, codeHash: string, now: number): boolean {
  const row = store.db
    .prepare("SELECT 1 AS ok FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(codeHash, now);
  return row !== undefined;
}

/**
 * Spend an invite on a user. True when exactly one usable invite was spent.
 *
 * One conditional UPDATE rather than a read and then a write, so two signups racing for the same
 * code cannot both see it unused: the second finds nothing to update.
 */
export function consumeInvite(store: Store, codeHash: string, userId: string, now: number): boolean {
  const result = store.db
    .prepare(
      `UPDATE invites SET used_by = ?, used_at = ?
        WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?`,
    )
    .run(userId, now, codeHash, now);
  return Number(result.changes) === 1;
}
