// The refresh_tokens table. Rows hold a sha256 of the token, never the token itself.

import type { Store } from "./store.js";

export interface RefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toRow(row: Record<string, unknown> | undefined): RefreshTokenRow | null {
  if (!row) return null;
  return {
    id: String(row["id"]),
    userId: String(row["user_id"]),
    familyId: String(row["family_id"]),
    tokenHash: String(row["token_hash"]),
    createdAt: Number(row["created_at"]),
    expiresAt: Number(row["expires_at"]),
    usedAt: nullableNumber(row["used_at"]),
    revokedAt: nullableNumber(row["revoked_at"]),
  };
}

export function insertRefreshToken(store: Store, row: RefreshTokenRow): void {
  store.db
    .prepare(
      `INSERT INTO refresh_tokens
         (id, user_id, family_id, token_hash, created_at, expires_at, used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.userId,
      row.familyId,
      row.tokenHash,
      row.createdAt,
      row.expiresAt,
      row.usedAt,
      row.revokedAt,
    );
}

export function findRefreshTokenByHash(store: Store, tokenHash: string): RefreshTokenRow | null {
  return toRow(store.db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?").get(tokenHash));
}

export function markRefreshTokenUsed(store: Store, id: string, now: number): void {
  store.db.prepare("UPDATE refresh_tokens SET used_at = ? WHERE id = ?").run(now, id);
}

/** Revoke every token in a family that is not already revoked. Returns how many it touched. */
export function revokeRefreshFamily(store: Store, familyId: string, now: number): number {
  const result = store.db
    .prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL")
    .run(now, familyId);
  return Number(result.changes);
}

/**
 * Delete rows that can never be presented successfully again: expired ones, and used or revoked
 * ones old enough that reuse detection no longer needs them. A used row is kept until its family's
 * newest token would itself have expired, which is at most the refresh lifetime after it was used.
 */
export function pruneRefreshTokens(store: Store, now: number, lifetimeMs: number): number {
  const result = store.db
    .prepare(
      `DELETE FROM refresh_tokens
        WHERE expires_at <= ?
           OR (used_at IS NOT NULL AND used_at <= ?)
           OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
    )
    .run(now, now - lifetimeMs, now - lifetimeMs);
  return Number(result.changes);
}
