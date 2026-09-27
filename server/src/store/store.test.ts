// The store: node:sqlite behind a thin layer that owns migrations and transactions.
//
// Every test here runs against ":memory:" except the ones whose subject is the file itself (WAL,
// reopening an existing database), which use a throwaway directory. Nothing touches data/.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { openStore, type Store } from "./store.js";

const opened: Store[] = [];
const dirs: string[] = [];

function open(options: Parameters<typeof openStore>[0]): Store {
  const store = openStore(options);
  opened.push(store);
  return store;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tv-store-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const store of opened.splice(0)) {
    if (store.db.isOpen) store.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function versions(store: Store): number[] {
  return store.db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((row) => Number(row["version"]));
}

describe("openStore", () => {
  it("applies every migration to a new database and records each one", () => {
    const store = open({ path: ":memory:" });
    expect(versions(store)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("creates the placeholder meta table in migration 1", () => {
    const store = open({ path: ":memory:" });
    store.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("k", "v");
    expect(store.db.prepare("SELECT value FROM meta WHERE key = ?").get("k")).toEqual({ value: "v" });
  });

  it("enables foreign keys", () => {
    const store = open({ path: ":memory:" });
    expect(store.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("uses WAL for a file database", () => {
    const store = open({ path: join(tempDir(), "t.db") });
    expect(store.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
  });

  it("creates the parent directory of a file database", () => {
    const path = join(tempDir(), "nested", "deeper", "t.db");
    const store = open({ path });
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
  });

  it("is idempotent: reopening applies nothing twice and keeps the data", () => {
    const path = join(tempDir(), "t.db");
    const first = open({ path });
    first.db.prepare("INSERT INTO meta (key, value) VALUES ('kept', 'yes')").run();
    first.close();

    const second = open({ path });
    expect(versions(second)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(second.db.prepare("SELECT value FROM meta WHERE key = 'kept'").get()).toEqual({
      value: "yes",
    });
  });

  it("applies only the migrations appended since the last open", () => {
    const path = join(tempDir(), "t.db");
    open({ path, migrations: ["CREATE TABLE a (id INTEGER PRIMARY KEY)"] }).close();

    // If migration 1 ran again it would fail on the existing table, so success is the proof.
    const store = open({
      path,
      migrations: [
        "CREATE TABLE a (id INTEGER PRIMARY KEY)",
        "CREATE TABLE b (id INTEGER PRIMARY KEY)",
      ],
    });
    expect(versions(store)).toEqual([1, 2]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toEqual({
      name: "b",
    });
  });

  it("rolls a failing migration back and records nothing for it", () => {
    const path = join(tempDir(), "t.db");
    expect(() =>
      openStore({
        path,
        migrations: [
          "CREATE TABLE ok (id INTEGER PRIMARY KEY)",
          "CREATE TABLE half (id INTEGER PRIMARY KEY); THIS IS NOT SQL",
        ],
      }),
    ).toThrow(/migration 2/);

    const store = open({ path, migrations: ["CREATE TABLE ok (id INTEGER PRIMARY KEY)"] });
    expect(versions(store)).toEqual([1]);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get()).toBeUndefined();
  });

  it("refuses a database migrated by newer code than this", () => {
    const path = join(tempDir(), "t.db");
    open({ path, migrations: ["SELECT 1", "SELECT 2"] }).close();
    expect(() => openStore({ path, migrations: ["SELECT 1"] })).toThrow(/newer/);
  });
});

describe("transaction", () => {
  function withTable(): Store {
    const store = open({ path: ":memory:" });
    store.db.exec("CREATE TABLE t (n INTEGER NOT NULL)");
    return store;
  }
  const count = (store: Store) => Number(store.db.prepare("SELECT count(*) AS c FROM t").get()?.["c"]);

  it("commits and returns the callback's value", () => {
    const store = withTable();
    const result = store.transaction(() => {
      store.db.prepare("INSERT INTO t (n) VALUES (1)").run();
      return "done";
    });
    expect(result).toBe("done");
    expect(count(store)).toBe(1);
    expect(store.db.isTransaction).toBe(false);
  });

  it("rolls back everything and rethrows when the callback throws", () => {
    const store = withTable();
    expect(() =>
      store.transaction(() => {
        store.db.prepare("INSERT INTO t (n) VALUES (1)").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count(store)).toBe(0);
    expect(store.db.isTransaction).toBe(false);
  });

  it("nests as a savepoint, so an inner failure undoes only the inner work", () => {
    const store = withTable();
    store.transaction(() => {
      store.db.prepare("INSERT INTO t (n) VALUES (1)").run();
      expect(() =>
        store.transaction(() => {
          store.db.prepare("INSERT INTO t (n) VALUES (2)").run();
          throw new Error("inner");
        }),
      ).toThrow("inner");
    });
    expect(count(store)).toBe(1);
  });

  it("refuses an async callback and rolls back, since it would commit before its awaits ran", () => {
    const store = withTable();
    expect(() =>
      store.transaction(async () => {
        store.db.prepare("INSERT INTO t (n) VALUES (1)").run();
      }),
    ).toThrow(/synchronous/);
    expect(count(store)).toBe(0);
  });
});
