// The user_glossary table: a person's saved glossary, in the order they saved it.

import type { GlossaryEntry } from "@translatv/shared";
import type { Store } from "./store.js";

export function findGlossary(store: Store, userId: string): GlossaryEntry[] {
  return store.db
    .prepare(
      `SELECT source, target, source_dialect, target_dialect FROM user_glossary
        WHERE user_id = ? ORDER BY position`,
    )
    .all(userId)
    .map((row) => ({
      source: String(row["source"]),
      target: String(row["target"]),
      sourceDialect: String(row["source_dialect"]),
      targetDialect: String(row["target_dialect"]),
    }));
}

/** Replace the whole list. The caller runs this inside a transaction so a half list never lands. */
export function replaceGlossary(store: Store, userId: string, entries: readonly GlossaryEntry[]): void {
  store.db.prepare("DELETE FROM user_glossary WHERE user_id = ?").run(userId);
  const insert = store.db.prepare(
    `INSERT INTO user_glossary (user_id, position, source, target, source_dialect, target_dialect)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  entries.forEach((entry, position) => {
    insert.run(userId, position, entry.source, entry.target, entry.sourceDialect, entry.targetDialect);
  });
}
