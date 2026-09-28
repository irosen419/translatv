// The users table. Owns its SQL and nothing else: policy (who may sign up, what a valid password
// is) lives in server/src/auth/, which is the only caller.

import { randomBytes } from "node:crypto";
import type { Store } from "./store.js";

export interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isOwner: boolean;
  createdAt: number;
}

/** An opaque random id. 128 bits, base64url, with no relationship to the email at all. */
export function newUserId(): string {
  return randomBytes(16).toString("base64url");
}

function toRow(row: Record<string, unknown> | undefined): UserRow | null {
  if (!row) return null;
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    passwordHash: String(row["password_hash"]),
    displayName: String(row["display_name"]),
    isOwner: Number(row["is_owner"]) === 1,
    createdAt: Number(row["created_at"]),
  };
}

export function insertUser(store: Store, user: UserRow): void {
  store.db
    .prepare(
      `INSERT INTO users (id, email, password_hash, display_name, is_owner, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(user.id, user.email, user.passwordHash, user.displayName, user.isOwner ? 1 : 0, user.createdAt);
}

/** By email, which the caller has already normalized. */
export function findUserByEmail(store: Store, email: string): UserRow | null {
  return toRow(store.db.prepare("SELECT * FROM users WHERE email = ?").get(email));
}

export function findUserById(store: Store, id: string): UserRow | null {
  return toRow(store.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
}

/**
 * Make is_owner agree with OWNER_EMAIL: exactly the account with that email is the owner, and
 * with no OWNER_EMAIL nobody is. Run at boot, so changing the setting and restarting moves the
 * role rather than leaving it with whoever held it when their row was written.
 */
export function syncOwner(store: Store, ownerEmail: string | null): void {
  store.db
    .prepare("UPDATE users SET is_owner = CASE WHEN email = ? THEN 1 ELSE 0 END")
    .run(ownerEmail ?? "");
}
