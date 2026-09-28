// openStore on a Node from before 22.16, whose node:sqlite has no DatabaseSync#isTransaction.
//
// store.test.ts proves assertSupportedSqlite refuses such a connection. This proves openStore
// asks it. A supported Node always has the property, so here the one module that loads
// node:sqlite hands openStore a connection that works in every other way but lacks it. Its own
// file, because vi.mock replaces the module for every test in the file.

import { expect, it, vi } from "vitest";

import { openStore } from "./store.js";

vi.mock("./sqlite.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./sqlite.js")>();
  // On an old Node the property does not exist at all: undefined to read, false to `in`, and no
  // descriptor. On a real connection it is an own, non-configurable accessor, which a subclass
  // cannot shadow and a proxy over that connection may not deny to `in` (a proxy invariant). So
  // this proxies an empty object and forwards every other key to a real connection, with methods
  // bound to it, because node:sqlite's native methods refuse any other receiver.
  class DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      const db = new real.DatabaseSync(...args);
      const absent = (key: string | symbol) => key === "isTransaction";
      return new Proxy(
        {},
        {
          get(_, key) {
            if (absent(key)) return undefined;
            const value: unknown = Reflect.get(db, key, db);
            return typeof value === "function" ? value.bind(db) : value;
          },
          has(_, key) {
            return !absent(key) && Reflect.has(db, key);
          },
        },
      );
    }
  }
  return { ...real, DatabaseSync };
});

it("refuses to open on a node:sqlite from before 22.16, naming the Node it needs", () => {
  expect(() => openStore({ path: ":memory:" })).toThrow(/Node 22\.16/);
});
