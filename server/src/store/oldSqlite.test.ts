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
  // The property is an own, non-configurable accessor on each instance, so a subclass cannot
  // shadow it, but a proxy over a real connection can. Methods are bound to the real connection,
  // because node:sqlite's native methods refuse any other receiver.
  class DatabaseSync {
    constructor(...args: ConstructorParameters<typeof real.DatabaseSync>) {
      const db = new real.DatabaseSync(...args);
      return new Proxy(db, {
        get(target, key) {
          if (key === "isTransaction") return undefined;
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }
  }
  return { ...real, DatabaseSync };
});

it("refuses to open on a node:sqlite from before 22.16, naming the Node it needs", () => {
  expect(() => openStore({ path: ":memory:" })).toThrow(/Node 22\.16/);
});
