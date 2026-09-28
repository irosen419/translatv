// The store: node:sqlite behind a thin layer that owns migrations and transactions.
//
// Every test here runs against ":memory:" except the ones whose subject is the file itself (WAL,
// reopening an existing database), which use a throwaway directory. Nothing touches data/.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "./migrations.js";
import { DatabaseSync } from "./sqlite.js";
import { assertSupportedSqlite, MIGRATIONS_TABLE, openStore, type Store } from "./store.js";

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

  it("erases without waiting: false at once while another connection reads, true after", () => {
    // The server's one connection is synchronous, so an erase that waited out busy_timeout would
    // stall every call on the server for five seconds (measured in review). A reader holding a
    // snapshot keeps the WAL from being emptied, and the erase has to say so at once. Under 200 ms,
    // not merely under the five seconds: a wait lowered to 2 s passed a 2.5 s bound and a 400 ms
    // wait a 500 ms one (both measured in review), while no wait takes about 1 ms, and under 15
    // with every core busy.
    const path = join(tempDir(), "t.db");
    const store = open({ path });
    store.db.exec("CREATE TABLE scratch (v TEXT); INSERT INTO scratch VALUES ('a')");
    const reader = new DatabaseSync(path);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM scratch").get();
      const started = performance.now();
      expect(store.erase()).toBe(false);
      expect(performance.now() - started).toBeLessThan(200);
      reader.exec("COMMIT");
      expect(store.erase()).toBe(true);
      // The wait is lowered only for the erase, and put back.
      expect(Number(store.db.prepare("PRAGMA busy_timeout").get()?.["timeout"])).toBeGreaterThanOrEqual(5000);
    } finally {
      reader.close();
    }
  });

  it("rewrites nothing while a reader keeps the WAL in use, and leaves the WAL empty whenever it answers true", () => {
    // A rewrite beside a reader lands in a WAL nobody can empty: each attempt appended a full copy
    // of the database to it (4 MB per attempt on a 4 MB file, measured in review), once a minute
    // for an hour per deletion. The reader here took the NEWEST snapshot, the case where every
    // frame can be copied back while the WAL stays in use, so "the WAL was not emptied" is told by
    // busy alone: log equal to checkpointed said done 18% of the time beside a busy reader
    // (measured in review). And true means both halves ran in order: a rewrite after the last
    // checkpoint leaves its copy of every page in the WAL.
    const path = join(tempDir(), "t.db");
    const store = open({ path });
    store.db.exec("CREATE TABLE scratch (v TEXT)");
    const insert = store.db.prepare("INSERT INTO scratch VALUES (?)");
    for (let i = 0; i < 200; i += 1) insert.run("x".repeat(2000));
    const wal = () => statSync(`${path}-wal`).size;
    const reader = new DatabaseSync(path);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM scratch").get();
      const before = wal();
      for (let attempt = 0; attempt < 3; attempt += 1) expect(store.erase()).toBe(false);
      expect(wal()).toBeLessThanOrEqual(before);
      reader.exec("COMMIT");
      expect(store.erase()).toBe(true);
      expect(wal()).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("answers false, at once, when a reader keeps the database file itself in use", () => {
    // A reader that took its snapshot while the WAL was empty reads the database file, so the
    // first checkpoint has nothing to wait for and the rewrite runs; the SECOND checkpoint is the
    // one that cannot copy it back. Its answer has to be heard: ignored, erase said done with the
    // file unrewritten and no retry to follow. And not waited for: the wait put back before it
    // froze the server for five seconds. Both measured in review.
    const path = join(tempDir(), "t.db");
    const store = open({ path });
    store.db.exec("CREATE TABLE scratch (v TEXT); INSERT INTO scratch VALUES ('a')");
    expect(store.erase()).toBe(true);
    const reader = new DatabaseSync(path);
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) AS n FROM scratch").get();
      const started = performance.now();
      expect(store.erase()).toBe(false);
      expect(performance.now() - started).toBeLessThan(200);
      reader.exec("COMMIT");
      expect(store.erase()).toBe(true);
    } finally {
      reader.close();
    }
  });

  it("leaves nothing in a page's unused space once it answers true", () => {
    // Where secure_delete cannot reach: a page's unallocated gap, where rebuilding a page leaves
    // older copies of rows (review found deleted account ids there). Planted through the file
    // format itself, so this does not hang on when SQLite happens to split a page, and only a
    // rewrite clears it. The freelist check alone passed with auto_vacuum freeing the pages
    // instead, and with a rewrite run only when pages were free (both measured in review).
    const path = join(tempDir(), "t.db");
    const first = openStore({ path });
    first.db.exec("INSERT INTO meta (key, value) VALUES ('planted', 'x')");
    expect(first.erase()).toBe(true);
    const root = Number(first.db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'meta'").get()?.["rootpage"]);
    first.close();

    const marker = `PLANTED-${randomBytes(6).toString("hex")}`;
    const file = readFileSync(path);
    const page = (root - 1) * file.readUInt16BE(16);
    expect(file[page]).toBe(13); // a leaf table page: an 8 byte header, then the cell pointers
    const gap = 8 + 2 * file.readUInt16BE(page + 3);
    expect((file.readUInt16BE(page + 5) || 65536) - gap).toBeGreaterThan(marker.length + 16);
    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.from(marker), 0, marker.length, page + gap + 8);
    closeSync(fd);

    const store = open({ path });
    expect(store.db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(readFileSync(path).includes(marker)).toBe(true); // the control
    expect(store.erase()).toBe(true);
    expect([path, `${path}-wal`].filter((f) => existsSync(f) && readFileSync(f).includes(marker))).toEqual([]);
  });

  it("waits for a busy file database rather than failing at once", () => {
    // The invite CLI opens the same file while the server has it, and a writer that finds the
    // other holding the lock should wait for it (measured: a 2.6 s wait, then success). At least
    // five seconds, so a longer wait is a legitimate change and a shorter one is not.
    const store = open({ path: join(tempDir(), "t.db") });
    expect(Number(store.db.prepare("PRAGMA busy_timeout").get()?.["timeout"])).toBeGreaterThanOrEqual(5000);
  });

  it("refuses a Node whose node:sqlite has no isTransaction (before 22.16)", () => {
    // transaction() decides whether to roll back by reading db.isTransaction. Where it is
    // undefined, every callback that throws leaves its transaction open: each later call fails
    // "cannot start a transaction within a transaction", and the writes inside never commit.
    // That openStore calls this is proved in oldSqlite.test.ts, which hands it a working
    // connection without the property.
    expect(() => assertSupportedSqlite({})).toThrow(/Node 22\.16/);
    expect(() => assertSupportedSqlite({ isTransaction: false })).not.toThrow();
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

describe("migrations", () => {
  /**
   * The first 16 hex characters of each shipped migration's sha256, in order.
   *
   * A database records WHICH versions it has applied, not what they said, so editing a migration
   * that has shipped splits every existing install from every new one, with no error anywhere.
   * Appending a migration needs no change here; once it has shipped, append its hash too.
   */
  const SHIPPED = [
    "d14c4ffe9d417b95",
    "df8e8cde7ad1c751",
    "ffd44914db2d7a6a",
    "0c01996a6f9f1b0d",
    "b672d3c58ce98403",
    "bcbbf75dbc805c58",
    "95652c844ecc9110",
    "30f4a0fa4a596827",
  ];

  it("never changes or reorders a shipped migration: they are append only", () => {
    const hashes = MIGRATIONS.map((sql) => createHash("sha256").update(sql).digest("hex").slice(0, 16));
    expect(hashes.slice(0, SHIPPED.length)).toEqual(SHIPPED);
  });

  it("never changes the table that records them either", () => {
    // Created IF NOT EXISTS, so a change here reaches new databases only: the same split.
    expect(createHash("sha256").update(MIGRATIONS_TABLE).digest("hex").slice(0, 16)).toBe("b8e562b60fdc64fb");
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

  it("rethrows the real error from a NESTED call when SQLite has ended the whole transaction", () => {
    // After SQLite ends the transaction itself, the savepoint is gone too, and a ROLLBACK TO
    // there fails "no such savepoint" over the error that explains it. The outer call then has
    // nothing to commit and fails too, even though it caught the inner error.
    const store = withTable();
    store.db.exec("CREATE TABLE big (b BLOB NOT NULL)");
    const pages = Number(store.db.prepare("PRAGMA page_count").get()?.["page_count"]);
    store.db.exec(`PRAGMA max_page_count = ${pages + 2}`);

    let inner: unknown = null;
    expect(() =>
      store.transaction(() => {
        try {
          store.transaction(() => {
            for (let i = 0; i < 64; i += 1) store.db.prepare("INSERT INTO big (b) VALUES (zeroblob(4096))").run();
          });
        } catch (error) {
          inner = error;
        }
      }),
    ).toThrow();
    expect(String(inner)).toMatch(/full/);
    expect(store.db.isTransaction).toBe(false);

    store.db.exec("PRAGMA max_page_count = 1073741823");
    expect(store.transaction(() => "after")).toBe("after");
  });

  describe("against a second connection to the same file", () => {
    // Lock mode is invisible on one connection, so these use two. An outer call must start with
    // BEGIN IMMEDIATE, taking the write lock at once; a call that wrongly thinks it is nested
    // runs a SAVEPOINT instead, which takes no lock until its first write, and then the other
    // connection can write in the middle of it. (Probes by the round 2 reviewer.)
    function pair(): { store: Store; other: DatabaseSync } {
      const path = join(tempDir(), "t.db");
      const store = open({ path, migrations: ["CREATE TABLE t (n INTEGER NOT NULL)"] });
      const other = new DatabaseSync(path);
      other.exec("PRAGMA busy_timeout = 0");
      return { store, other };
    }
    function otherCanWriteInside(store: Store, other: DatabaseSync): boolean {
      let wrote = true;
      store.transaction(() => {
        try {
          other.exec("INSERT INTO t (n) VALUES (1)");
        } catch {
          wrote = false; // SQLITE_BUSY: this transaction holds the write lock
        }
      });
      return wrote;
    }

    it("takes the write lock at the start of every outer call, including after a callback threw", () => {
      const { store, other } = pair();
      try {
        expect(() =>
          store.transaction(() => {
            throw new Error("callback failed");
          }),
        ).toThrow("callback failed");
        expect(otherCanWriteInside(store, other)).toBe(false);
      } finally {
        other.close();
      }
    });

    it("stays an outer call after a BEGIN refused on a busy database", () => {
      const { store, other } = pair();
      store.db.exec("PRAGMA busy_timeout = 0");
      try {
        other.exec("BEGIN IMMEDIATE");
        expect(() => store.transaction(() => "never")).toThrow(/locked|busy/);
        other.exec("ROLLBACK");
        expect(otherCanWriteInside(store, other)).toBe(false);
      } finally {
        other.close();
      }
    });
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

  it("stays usable after a COMMIT fails, at the outer level and nested", () => {
    // A COMMIT can fail after the callback returned: here a deferred foreign key, in production a
    // full disk. The depth counter used to be decremented once before COMMIT and again in the
    // catch, so it ended at -1 and every later call ran "SAVEPOINT sp_-1", a syntax error, until
    // the process restarted: no sign in, refresh or signup would work.
    const store = open({
      path: ":memory:",
      migrations: [
        `CREATE TABLE parent (id INTEGER PRIMARY KEY);
         CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)`,
      ],
    });
    const orphan = () => store.db.prepare("INSERT INTO child (parent_id) VALUES (42)").run();

    expect(() => store.transaction(orphan)).toThrow(/FOREIGN KEY/);
    expect(store.db.isTransaction).toBe(false);

    expect(store.transaction(() => store.transaction(() => "nested"))).toBe("nested");
    expect(() => store.transaction(() => store.transaction(orphan))).toThrow(/FOREIGN KEY/);
    expect(store.transaction(() => "after")).toBe("after");
    expect(Number(store.db.prepare("SELECT count(*) AS c FROM child").get()?.["c"])).toBe(0);
  });

  it("rethrows the error that failed the transaction when SQLite has already rolled it back", () => {
    // SQLite ends a transaction itself on some errors, a full database among them, and the
    // ROLLBACK that follows then fails with "no transaction is active". Thrown from the catch,
    // that second error replaced the one that says what went wrong.
    const store = withTable();
    store.db.exec("CREATE TABLE big (b BLOB NOT NULL)");
    const pages = Number(store.db.prepare("PRAGMA page_count").get()?.["page_count"]);
    store.db.exec(`PRAGMA max_page_count = ${pages + 2}`);

    expect(() =>
      store.transaction(() => {
        for (let i = 0; i < 64; i += 1) store.db.prepare("INSERT INTO big (b) VALUES (zeroblob(4096))").run();
      }),
    ).toThrow(/full/);
    expect(store.db.isTransaction).toBe(false);

    store.db.exec("PRAGMA max_page_count = 1073741823");
    expect(store.transaction(() => "after")).toBe("after");
  });
});
