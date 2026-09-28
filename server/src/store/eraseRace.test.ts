// Store.erase when another connection takes the write lock between its first checkpoint and the
// rewrite.
//
// That window is microseconds wide: a writer that already holds the lock makes the first
// checkpoint report busy, so the rewrite never starts (measured in review). Nothing but a hook
// between the two statements reaches it, so here the one module that loads node:sqlite hands
// openStore a connection that runs a hook just before VACUUM. Everything else is real SQLite,
// the busy error included. Its own file, because vi.mock replaces the module for every test in
// the file.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { DatabaseSync } from "./sqlite.js";
import { openStore, type Store } from "./store.js";

const hook = vi.hoisted(() => ({ beforeVacuum: null as null | (() => void) }));

vi.mock("./sqlite.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sqlite.js")>();
  class HookedDatabaseSync extends real.DatabaseSync {
    override exec(sql: string): void {
      if (sql === "VACUUM") hook.beforeVacuum?.();
      super.exec(sql);
    }
  }
  return { ...real, DatabaseSync: HookedDatabaseSync };
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  hook.beforeVacuum = null;
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
  expect(performance.now() - started).toBeLessThan(200);
  expect(wait(store)).toBeGreaterThanOrEqual(5000);

  hook.beforeVacuum = null;
  writer.exec("ROLLBACK");
  expect(store.erase()).toBe(true);
});

it("throws anything but a busy database from the rewrite, and still puts the wait back", () => {
  const { store } = fileStore();
  hook.beforeVacuum = () => {
    throw Object.assign(new Error("disk I/O error"), { errcode: 10 });
  };
  expect(() => store.erase()).toThrow("disk I/O error");
  expect(wait(store)).toBeGreaterThanOrEqual(5000);
});
