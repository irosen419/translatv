// The blocks table: who has blocked whom. Owns its SQL and nothing else. Policy (who may block
// whom, and what a block does to a room) lives in server/src/account/.

import type { Store } from "./store.js";

export interface BlockRow {
  blockedId: string;
  /** The blocked account's CURRENT display name, joined at read time. */
  displayName: string;
  createdAt: number;
}

/** Block. A pair already blocked is left as it was, first time kept. */
export function insertBlock(store: Store, blockerId: string, blockedId: string, now: number): void {
  store.db
    .prepare("INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)")
    .run(blockerId, blockedId, now);
}

/** Unblock. True when there was a block to remove. */
export function deleteBlock(store: Store, blockerId: string, blockedId: string): boolean {
  return (
    Number(store.db.prepare("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?").run(blockerId, blockedId).changes) === 1
  );
}

/** Everyone this account has blocked, newest block first. */
export function listBlocks(store: Store, blockerId: string): BlockRow[] {
  return store.db
    .prepare(
      `SELECT b.blocked_id, u.display_name, b.created_at FROM blocks b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC, b.blocked_id`,
    )
    .all(blockerId)
    .map((row) => ({
      blockedId: String(row["blocked_id"]),
      displayName: String(row["display_name"]),
      createdAt: Number(row["created_at"]),
    }));
}

/** Has either of these two accounts blocked the other? */
export function blockedEitherWay(store: Store, a: string, b: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 AS hit FROM blocks
        WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
        LIMIT 1`,
    )
    .get(a, b, b, a);
  return row !== undefined;
}
