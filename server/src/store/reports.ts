// The reports table. Owns its SQL and nothing else. Policy (who may report whom, how often, and
// who may read them) lives in server/src/account/ and server/src/auth/routes.ts.

import type { ReportReason, ReportStatus } from "@translatv/shared";
import type { Store } from "./store.js";

export interface ReportRow {
  id: string;
  reason: ReportReason;
  details: string | null;
  status: ReportStatus;
  createdAt: number;
  reviewedAt: number | null;
  reporterId: string | null;
  reporterName: string | null;
  reportedId: string | null;
  reportedName: string | null;
}

export function insertReport(
  store: Store,
  row: { id: string; reporterId: string; reportedId: string; reason: ReportReason; details: string | null; createdAt: number },
): void {
  store.db
    .prepare(
      `INSERT INTO reports (id, reporter_id, reported_id, reason, details, status, created_at, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, NULL)`,
    )
    .run(row.id, row.reporterId, row.reportedId, row.reason, row.details, row.createdAt);
}

const SELECT = `SELECT r.*, a.display_name AS reporter_name, b.display_name AS reported_name FROM reports r
   LEFT JOIN users a ON a.id = r.reporter_id
   LEFT JOIN users b ON b.id = r.reported_id`;

function toRow(row: Record<string, unknown>): ReportRow {
  const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
  return {
    id: String(row["id"]),
    reason: String(row["reason"]) as ReportReason,
    details: text(row["details"]),
    status: String(row["status"]) as ReportStatus,
    createdAt: Number(row["created_at"]),
    reviewedAt: row["reviewed_at"] === null ? null : Number(row["reviewed_at"]),
    reporterId: text(row["reporter_id"]),
    reporterName: text(row["reporter_name"]),
    reportedId: text(row["reported_id"]),
    reportedName: text(row["reported_name"]),
  };
}

/** Open reports first, then reviewed ones, each newest first, at most `limit`. */
export function listReports(store: Store, limit: number): ReportRow[] {
  return store.db
    .prepare(`${SELECT} ORDER BY (r.status = 'open') DESC, r.created_at DESC, r.id DESC LIMIT ?`)
    .all(limit)
    .map(toRow);
}

export function findReport(store: Store, id: string): ReportRow | null {
  const row = store.db.prepare(`${SELECT} WHERE r.id = ?`).get(id);
  return row ? toRow(row) : null;
}

/** Mark reviewed. Only the first review counts, so the time it records is when it was read. */
export function markReviewed(store: Store, id: string, now: number): void {
  store.db.prepare("UPDATE reports SET status = 'reviewed', reviewed_at = ? WHERE id = ? AND status = 'open'").run(now, id);
}
