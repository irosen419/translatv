import { describe, expect, it } from "vitest";
import { clearToken, readToken, TOKEN_KEY, writeToken, type TokenStore } from "./adminSession.js";

function memoryStore(initial: Record<string, string> = {}): TokenStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
    removeItem: (k) => {
      delete data[k];
    },
  };
}

/** Safari in private mode, an embedded webview, a user who blocked site data. */
const throwingStore: TokenStore = {
  getItem() {
    throw new Error("storage disabled");
  },
  setItem() {
    throw new Error("storage disabled");
  },
  removeItem() {
    throw new Error("storage disabled");
  },
};

describe("the stored admin token", () => {
  it("round trips through a working store", () => {
    const store = memoryStore();
    writeToken(store, "a.token");
    expect(readToken(store)).toBe("a.token");
    clearToken(store);
    expect(readToken(store)).toBe(null);
  });

  it("reads as absent when there is no store at all", () => {
    expect(readToken(null)).toBe(null);
  });

  it("treats an empty value as no token rather than as a token", () => {
    // A cleared key can read back as "" rather than absent. Sending "" would be refused as a
    // bad credential, which looks like a wrong password instead of like not being logged in.
    expect(readToken(memoryStore({ [TOKEN_KEY]: "" }))).toBe(null);
  });

  // Storage that throws must degrade to "not logged in", never to a broken page. Reading is the
  // one that matters: it runs on first paint, before anyone has done anything.
  it("survives a store that throws on every operation", () => {
    expect(readToken(throwingStore)).toBe(null);
    expect(() => writeToken(throwingStore, "a.token")).not.toThrow();
    expect(() => clearToken(throwingStore)).not.toThrow();
  });

  it("does nothing, quietly, when asked to write or clear without a store", () => {
    expect(() => writeToken(null, "a.token")).not.toThrow();
    expect(() => clearToken(null)).not.toThrow();
  });
});
