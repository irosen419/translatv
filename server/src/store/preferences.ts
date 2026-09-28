// The user_preferences table. One row per account at most; a missing row means nothing chosen.

import type { Store } from "./store.js";

export interface PreferencesRow {
  dialect: string | null;
  uiDialect: string | null;
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export function findPreferences(store: Store, userId: string): PreferencesRow | null {
  const row = store.db.prepare("SELECT dialect, ui_dialect FROM user_preferences WHERE user_id = ?").get(userId);
  if (!row) return null;
  return { dialect: nullableText(row["dialect"]), uiDialect: nullableText(row["ui_dialect"]) };
}

export function savePreferences(store: Store, userId: string, prefs: PreferencesRow, now: number): void {
  store.db
    .prepare(
      `INSERT INTO user_preferences (user_id, dialect, ui_dialect, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         dialect = excluded.dialect,
         ui_dialect = excluded.ui_dialect,
         updated_at = excluded.updated_at`,
    )
    .run(userId, prefs.dialect, prefs.uiDialect, now);
}
