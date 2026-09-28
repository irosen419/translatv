// The SQLite store: open, migrate, and run work in transactions.
//
// Deliberately thin. Tables get one repository module each (users, tokens and so on, from M3
// onward), and each takes a Store and owns the SQL for its own table. This file owns only what
// every repository shares: the connection, the schema version, and transactions.
//
// Synchronous, because node:sqlite's DatabaseSync is. For this server's scale (a handful of
// small reads and writes per sign in, none on the per sentence path) a synchronous query of a
// local file is microseconds, and it removes a whole class of interleaving bugs.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATIONS } from "./migrations.js";
import { DatabaseSync } from "./sqlite.js";

export interface StoreOptions {
  /** A file path, or ":memory:" for a private in memory database (what the tests use). */
  path: string;
  /** Overridable for tests of the migration mechanism itself. Defaults to the real schema. */
  migrations?: readonly string[];
}

export interface Store {
  readonly db: DatabaseSync;
  readonly path: string;
  /** The highest migration applied to this database. */
  schemaVersion(): number;
  /**
   * Run fn inside a transaction: commit when it returns, roll back and rethrow when it throws.
   * Nested calls become savepoints, so an inner failure undoes only the inner work, UNLESS SQLite
   * itself ended the whole transaction (a full disk, an I/O error). Then everything written
   * before the failure is gone, and the outer call is no longer in a transaction at all: if it
   * catches the inner error and carries on, each later write (a later nested call's included)
   * commits on its own, and the outer call still fails at COMMIT. So an outer fn must not catch
   * a nested failure and keep writing. No caller nests today.
   *
   * fn must be synchronous. An async fn would return at its first await, the transaction would
   * commit, and the rest of its writes would land outside it: exactly the partial write a
   * transaction exists to prevent. So a returned promise is refused and the work rolled back.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Rewrite the database file from its live rows (VACUUM), then empty the WAL (a TRUNCATE
   * checkpoint), so nothing deleted stays readable in either file. secure_delete zeroes a deleted
   * row where it stood, but SQLite reorganizing a page can leave older copies of rows in the
   * page's unused space (review found deleted account ids there), which only a rewrite clears,
   * and the WAL keeps older copies of every page it wrote until it is emptied.
   *
   * True when both are done. False while another connection keeps the WAL in use (a reader, a
   * backup, an operator's shell) or holds the write lock, and the caller tries again later. The
   * WAL is emptied FIRST and the rewrite runs only once that works, because a rewrite beside a
   * reader lands in a WAL nobody can empty: a full copy of the file per attempt (measured in
   * review). A reader the first checkpoint cannot see still costs one such copy and the time of
   * the rewrite: one reading the database file itself (it began while the WAL was empty), or one
   * that starts between the two. The next attempt empties the WAL before rewriting again, so the
   * WAL holds at most one copy.
   *
   * Never waits for a lock. This connection is synchronous, so waiting out busy_timeout would
   * stall every call on the server for five seconds (measured). The rewrite itself does hold it,
   * for a time that grows with the file: 8 ms at 1.2 MB, about 0.7 s at 100 MB and 2.5 s at
   * 400 MB (measured in review), with about twice the file in spare disk while it runs.
   */
  erase(): boolean;
  close(): void;
}

const MEMORY = ":memory:";

/** SQLITE_BUSY or SQLITE_LOCKED, extended codes included: another connection holds the database. */
function isBusy(error: unknown): boolean {
  const code = Number((error as { errcode?: unknown } | null)?.errcode) & 0xff;
  return code === 5 || code === 6;
}

/**
 * The table that records which migrations a database has applied. It is shipped schema like any
 * migration (store.test.ts pins it the same way): a column added here would exist only in
 * databases created after the change. Byte for byte as it first shipped, hence the indentation.
 */
export const MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT`;

/**
 * Refuse a node:sqlite with no DatabaseSync#isTransaction, which first shipped in Node 22.16.
 * transaction() reads it to decide whether a rollback is needed; where it is undefined, every
 * callback that throws leaves its transaction open, each later call fails "cannot start a
 * transaction within a transaction", and the writes inside never commit. package.json's engines
 * floor says 22.16, but npm only warns about engines, so this is where it is enforced.
 */
export function assertSupportedSqlite(db: { isTransaction?: unknown }): void {
  if (typeof db.isTransaction !== "boolean") {
    throw new Error(
      `this Node's node:sqlite has no DatabaseSync#isTransaction: the store needs Node 22.16 or ` +
        `newer, and this is ${process.version}`,
    );
  }
}

export function openStore(options: StoreOptions): Store {
  const { path } = options;
  const migrations = options.migrations ?? MIGRATIONS;

  if (path !== MEMORY) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  try {
    assertSupportedSqlite(db);
    // SQLite itself leaves foreign keys off, per connection, and silently: a REFERENCES clause is
    // decoration until they are on, and every ON DELETE in migrations.ts with it. node:sqlite's
    // DatabaseSync happens to turn them on by default (enableForeignKeyConstraints); set here
    // anyway, so the account deletion cascade does not rest on a library default.
    db.exec("PRAGMA foreign_keys = ON");
    // A deleted row is overwritten with zeros rather than left behind as free space that a copy
    // of the file still reads. Deleting an account promises it is gone (the UI says so), and
    // without this its email, name and glossary stayed readable in translatv.db (measured in
    // review). What it cannot reach, older copies in reorganized pages and in the WAL, is erase's
    // job (below).
    db.exec("PRAGMA secure_delete = ON");
    if (path !== MEMORY) {
      // WAL lets reads proceed during a write, and survives a crash mid write as well as the
      // default journal does. It does not apply to an in memory database.
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA busy_timeout = 5000");
    }

    let depth = 0;
    const transaction = <T>(fn: () => T): T => {
      const savepoint = `sp_${depth}`;
      const outer = depth === 0;
      db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        if (result !== null && typeof (result as { then?: unknown })?.then === "function") {
          throw new Error(
            "store.transaction takes a synchronous function: an async one would commit at its " +
              "first await and write the rest outside the transaction",
          );
        }
        db.exec(outer ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        // Only when something is still open. SQLite ends the whole transaction by itself on some
        // failures (a full disk, an I/O error), and a ROLLBACK after that fails with "no
        // transaction is active": thrown from here, it would replace the error that says what
        // actually went wrong.
        if (db.isTransaction) db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      } finally {
        // Once per call, whichever way it ends. Decrementing before COMMIT and again in the catch
        // left depth at -1 after a failed COMMIT, and every later call then ran "SAVEPOINT sp_-1".
        depth -= 1;
      }
    };

    const schemaVersion = (): number => {
      const row = db.prepare("SELECT max(version) AS v FROM schema_migrations").get();
      return Number(row?.["v"] ?? 0);
    };

    db.exec(MIGRATIONS_TABLE);

    const current = schemaVersion();
    if (current > migrations.length) {
      // Running older code against a newer schema would read and write tables whose shape it
      // does not know. Refuse rather than guess.
      throw new Error(
        `the database is at schema version ${current}, newer than this server's ` +
          `${migrations.length}. Deploy the newer server, or restore a matching backup.`,
      );
    }

    const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let version = current + 1; version <= migrations.length; version += 1) {
      const sql = migrations[version - 1] as string;
      try {
        transaction(() => {
          db.exec(sql);
          record.run(version, new Date().toISOString());
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`migration ${version} failed and was rolled back: ${reason}`);
      }
    }

    return {
      db,
      path,
      schemaVersion,
      transaction,
      erase: () => {
        const wait = Number(db.prepare("PRAGMA busy_timeout").get()?.["timeout"] ?? 0);
        db.exec("PRAGMA busy_timeout = 0");
        // Emptied only when busy is 0. Not log == checkpointed: a reader that took the newest
        // snapshot lets every frame be copied back while it keeps the WAL in use, so those are
        // equal and the WAL is not emptied (18% of attempts beside a busy reader, measured in
        // review).
        const emptyWal = () => Number(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.["busy"] ?? 0) === 0;
        try {
          if (!emptyWal()) return false;
          try {
            db.exec("VACUUM");
          } catch (error) {
            // Another connection holds the write lock. Not now; the caller retries.
            if (isBusy(error)) return false;
            throw error;
          }
          return emptyWal();
        } finally {
          db.exec(`PRAGMA busy_timeout = ${wait}`);
        }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
