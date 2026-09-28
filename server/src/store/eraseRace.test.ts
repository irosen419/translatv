// Store.erase from inside: when another connection takes the write lock between its first
// checkpoint and the rewrite, and what the erase's own connection is set to at each statement.
//
// That window is microseconds wide: a writer that already holds the lock makes the first
// checkpoint report busy, so the rewrite never starts (measured in review). Nothing but a hook
// between the statements reaches it, so here the one module that loads node:sqlite hands
// openStore a connection that runs a hook just before each checkpoint and before VACUUM, however
// they are sent. Everything else is real SQLite, the busy error included. Its own file, because
// vi.mock replaces the module for every test in the file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { DatabaseSync } from "./sqlite.js";
import { openStore, type Store } from "./store.js";

type Hook = null | ((db: DatabaseSync) => void);
const hook = vi.hoisted(() => ({ beforeVacuum: null as Hook, beforeCheckpoint: null as Hook }));

vi.mock("./sqlite.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sqlite.js")>();
  // Sent through exec or a prepared statement run any way, in any case, after a comment or not: a
  // hook keyed on exec("VACUUM") alone failed the race tests when the rewrite was written another
  // correct way (measured in review).
  const VACUUM = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*vacuum\b/i;
  const CHECKPOINT = /\bwal_checkpoint\b/i;
  const hookFor = (sql: string): Hook =>
    VACUUM.test(sql) ? hook.beforeVacuum : CHECKPOINT.test(sql) ? hook.beforeCheckpoint : null;
  class HookedDatabaseSync extends real.DatabaseSync {
    override exec(sql: string): void {
      hookFor(sql)?.(this);
      super.exec(sql);
    }
    override prepare(sql: string): ReturnType<DatabaseSync["prepare"]> {
      const statement = super.prepare(sql);
      if (!VACUUM.test(sql) && !CHECKPOINT.test(sql)) return statement;
      const hooked =
        <A extends unknown[], R>(method: (...args: A) => R) =>
        (...args: A): R => {
          hookFor(sql)?.(this);
          return method(...args);
        };
      return Object.assign(statement, {
        run: hooked(statement.run.bind(statement)),
        get: hooked(statement.get.bind(statement)),
        all: hooked(statement.all.bind(statement)),
        iterate: hooked(statement.iterate.bind(statement)),
      });
    }
  }
  return { ...real, DatabaseSync: HookedDatabaseSync };
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  hook.beforeVacuum = null;
  hook.beforeCheckpoint = null;
  while (cleanup.length > 0) cleanup.pop()?.();
});

function fileStore(): { store: Store; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "tv-erase-race-"));
  const path = join(dir, "t.db");
  const store = openStore({ path });
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.db.exec("CREATE TABLE scratch (v TEXT); INSERT INTO scratch VALUES ('a')");
  return { store, path };
}

const wait = (store: Store) => Number(store.db.prepare("PRAGMA busy_timeout").get()?.["timeout"]);

it("answers false, and puts the wait back, when a writer takes the lock just before the rewrite", () => {
  // Reported done, the rewrite that never ran would never be retried; thrown, it would be
  // logged as a failure and left for the next deletion. Busy means "not now".
  const { store, path } = fileStore();
  const writer = new DatabaseSync(path);
  cleanup.push(() => writer.close());
  hook.beforeVacuum = () => writer.exec("BEGIN IMMEDIATE");

  const started = performance.now();
  expect(store.erase()).toBe(false);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(wait(store)).toBeGreaterThanOrEqual(5000);

  hook.beforeVacuum = null;
  writer.exec("ROLLBACK");
  expect(store.erase()).toBe(true);
});

it("reads a busy database's extended codes as busy too", () => {
  // node:sqlite reports extended codes (a write from a stale snapshot is 517, SQLITE_BUSY_SNAPSHOT,
  // measured in review), and the rewrite can meet one if another connection commits between its
  // read and write locks. Read as a failure, it would be logged and no retry scheduled.
  const { store } = fileStore();
  hook.beforeVacuum = () => {
    throw Object.assign(new Error("database is locked"), { errcode: 517 });
  };
  expect(store.erase()).toBe(false);
  expect(wait(store)).toBeGreaterThanOrEqual(5000);
});

it("waits for no lock at any of its statements", () => {
  // Read from inside the erase, because timing can only bound a wait, and loosely: CI runners
  // stall for hundreds of milliseconds (measured in review). A 50 ms wait before the rewrite, and
  // one of 50 ms at the first checkpoint or 900 ms at the second, each passed every bound
  // (measured in review), so the wait is read at all three.
  const { store } = fileStore();
  const seen: Array<[string, number]> = [];
  const read = (kind: string) => (db: DatabaseSync) =>
    seen.push([kind, Number(db.prepare("PRAGMA busy_timeout").get()?.["timeout"])]);
  hook.beforeCheckpoint = read("checkpoint");
  hook.beforeVacuum = read("rewrite");
  expect(store.erase()).toBe(true);
  expect(new Set(seen.map(([kind]) => kind))).toEqual(new Set(["checkpoint", "rewrite"]));
  expect(seen.filter(([, ms]) => ms !== 0)).toEqual([]);
  expect(wait(store)).toBeGreaterThanOrEqual(5000);
});

it("throws anything but a busy database from the rewrite, and still puts the wait back", () => {
  const { store } = fileStore();
  hook.beforeVacuum = () => {
    throw Object.assign(new Error("disk I/O error"), { errcode: 10 });
  };
  expect(() => store.erase()).toThrow("disk I/O error");
  expect(wait(store)).toBeGreaterThanOrEqual(5000);
});
