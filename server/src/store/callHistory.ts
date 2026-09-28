// The call_history table: one row per participant per call. Holds a room HASH, never a code, and
// nothing anyone said.

import type { Store } from "./store.js";

export interface CallRow {
  id: string;
  roomHash: string;
  peerUserId: string | null;
  /** The peer's CURRENT display name, joined at read time. Null when there is no peer row. */
  peerDisplayName: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface ContactRow {
  peerUserId: string;
  displayName: string;
  lastCallAt: number;
  callCount: number;
}

export function insertCall(
  store: Store,
  row: { id: string; userId: string; roomHash: string; peerUserId: string | null; startedAt: number },
): void {
  store.db
    .prepare(
      `INSERT INTO call_history (id, user_id, room_hash, peer_user_id, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(row.id, row.userId, row.roomHash, row.peerUserId, row.startedAt);
}

/** Fill in the peer on a row that has none yet. A row that already names a peer is left alone. */
export function setCallPeer(store: Store, id: string, peerUserId: string): void {
  store.db.prepare("UPDATE call_history SET peer_user_id = ? WHERE id = ? AND peer_user_id IS NULL").run(peerUserId, id);
}

/** Close a row. Only the first close counts, so a late sweep cannot stretch a finished call. */
export function endCall(store: Store, id: string, now: number): void {
  store.db.prepare("UPDATE call_history SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(now, id);
}

/**
 * One page of a user's calls, newest first. `before` is the (started_at, id) of the last row of
 * the previous page; the id breaks ties so two calls in one millisecond still page exactly once.
 */
export function listCalls(
  store: Store,
  userId: string,
  limit: number,
  before: { startedAt: number; id: string } | null,
): CallRow[] {
  const rows = before
    ? store.db
        .prepare(
          `SELECT c.*, u.display_name AS peer_display_name FROM call_history c
             LEFT JOIN users u ON u.id = c.peer_user_id
            WHERE c.user_id = ? AND (c.started_at < ? OR (c.started_at = ? AND c.id < ?))
            ORDER BY c.started_at DESC, c.id DESC LIMIT ?`,
        )
        .all(userId, before.startedAt, before.startedAt, before.id, limit)
    : store.db
        .prepare(
          `SELECT c.*, u.display_name AS peer_display_name FROM call_history c
             LEFT JOIN users u ON u.id = c.peer_user_id
            WHERE c.user_id = ?
            ORDER BY c.started_at DESC, c.id DESC LIMIT ?`,
        )
        .all(userId, limit);
  return rows.map((row) => ({
    id: String(row["id"]),
    roomHash: String(row["room_hash"]),
    peerUserId: row["peer_user_id"] === null ? null : String(row["peer_user_id"]),
    peerDisplayName: row["peer_display_name"] === null ? null : String(row["peer_display_name"]),
    startedAt: Number(row["started_at"]),
    endedAt: row["ended_at"] === null ? null : Number(row["ended_at"]),
  }));
}

/** Contacts, DERIVED: every distinct peer this user has a call with, most recent call first. */
export function listContacts(store: Store, userId: string): ContactRow[] {
  return store.db
    .prepare(
      `SELECT c.peer_user_id, u.display_name, max(c.started_at) AS last_call_at, count(*) AS calls
         FROM call_history c JOIN users u ON u.id = c.peer_user_id
        WHERE c.user_id = ?
        GROUP BY c.peer_user_id
        ORDER BY last_call_at DESC, c.peer_user_id`,
    )
    .all(userId)
    .map((row) => ({
      peerUserId: String(row["peer_user_id"]),
      displayName: String(row["display_name"]),
      lastCallAt: Number(row["last_call_at"]),
      callCount: Number(row["calls"]),
    }));
}
