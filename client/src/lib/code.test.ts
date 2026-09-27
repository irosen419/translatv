import { describe, expect, it } from "vitest";
import { codeFromPath, codeFromShared, isLikelyCode, normalizeCode, roomLink } from "./code.js";

describe("normalizeCode", () => {
  it("folds the lookalikes people mishear when reading a code aloud", () => {
    // This is the whole reason the alphabet excludes I, L, O, and U. Someone reads the code
    // over the phone, the listener types an O for a zero, and it has to still work.
    expect(normalizeCode("OILU")).toBe("011V");
    expect(normalizeCode("o0i1l")).toBe("00111");
  });

  it("ignores spacing and hyphens people add for readability", () => {
    expect(normalizeCode("abc-def12")).toBe("ABCDEF12");
    expect(normalizeCode(" hjkm npqr ")).toBe("HJKMNPQR");
  });

  it("matches the server's normalization", () => {
    // If these ever diverge, a code the client accepts becomes a room the server cannot find,
    // which reads to the user as "the code does not work" with no other clue.
    const cases = ["ABCD1234", "o0i1lu", "  x-y-z  ", "MNPQRSTV"];
    for (const input of cases) {
      const client = normalizeCode(input);
      const server = input
        .toUpperCase()
        .replace(/[\s-]/g, "")
        .replace(/O/g, "0")
        .replace(/[IL]/g, "1")
        .replace(/U/g, "V");
      expect(client).toBe(server);
    }
  });
});

describe("isLikelyCode", () => {
  it("accepts a well formed code", () => {
    expect(isLikelyCode("ABCD1234")).toBe(true);
    expect(isLikelyCode("abcd-1234")).toBe(true);
  });

  it("rejects the wrong length", () => {
    expect(isLikelyCode("ABC123")).toBe(false);
    expect(isLikelyCode("ABCD12345")).toBe(false);
  });

  it("rejects characters outside the alphabet", () => {
    expect(isLikelyCode("ABCD!234")).toBe(false);
  });

  it("accepts a code typed with lookalikes, because normalization fixes it", () => {
    expect(isLikelyCode("OOOO1111")).toBe(true);
  });
});

describe("codeFromPath", () => {
  it("reads a code out of a shared link", () => {
    expect(codeFromPath("/r/ABCD1234")).toBe("ABCD1234");
    expect(codeFromPath("/r/ABCD1234/")).toBe("ABCD1234");
  });

  it("normalizes a mistyped code in a link", () => {
    expect(codeFromPath("/r/abcd1234")).toBe("ABCD1234");
  });

  it("returns null for anything else", () => {
    expect(codeFromPath("/")).toBeNull();
    expect(codeFromPath("/r/")).toBeNull();
    expect(codeFromPath("/r/SHORT")).toBeNull();
    expect(codeFromPath("/r/WAYTOOLONG12")).toBeNull();
    expect(codeFromPath("/r/ABCD!234")).toBeNull();
    expect(codeFromPath("/rooms/ABCD1234")).toBeNull();
    expect(codeFromPath("/r/ABCD1234/extra")).toBeNull();
  });

  it("decodes percent encoding before validating", () => {
    // %31 is "1", so this is the code ABCD1234 arriving encoded. A link that survives a chat
    // app's mangling should still work.
    expect(codeFromPath("/r/ABCD%31234")).toBe("ABCD1234");
  });
});

describe("codeFromShared", () => {
  // The reported bug: someone clicks "Copy chat link", pastes it into the code field, and gets
  // a truncated mess. The field has to accept whatever the clipboard actually held.
  it("reads a code out of a full link", () => {
    expect(codeFromShared("http://localhost:5173/r/ABCD1234")).toBe("ABCD1234");
    expect(codeFromShared("https://chat.example.com/r/ABCD1234")).toBe("ABCD1234");
  });

  it("ignores a query string or hash the link picked up", () => {
    expect(codeFromShared("https://chat.example.com/r/ABCD1234?utm=x")).toBe("ABCD1234");
    expect(codeFromShared("https://chat.example.com/r/ABCD1234#top")).toBe("ABCD1234");
  });

  it("reads a bare path", () => {
    expect(codeFromShared("/r/ABCD1234")).toBe("ABCD1234");
    expect(codeFromShared("/r/ABCD1234/")).toBe("ABCD1234");
  });

  it("reads a link that lost its scheme", () => {
    // Chat apps and phone keyboards both do this. Without the scheme the string still parses as
    // a URL, just a nonsense one, so the parser cannot stop at its first answer.
    expect(codeFromShared("localhost:5173/r/ABCD1234")).toBe("ABCD1234");
    expect(codeFromShared("chat.example.com/r/ABCD1234?x=1")).toBe("ABCD1234");
  });

  it("normalizes a mistyped code inside a link", () => {
    expect(codeFromShared("http://localhost:5173/r/abcd1234")).toBe("ABCD1234");
  });

  it("returns null for a bare code, so ordinary typing falls straight through", () => {
    expect(codeFromShared("ABCD1234")).toBeNull();
    expect(codeFromShared("abcd-1234")).toBeNull();
  });

  it("returns null rather than a partial when the link carries a bad code", () => {
    expect(codeFromShared("http://localhost:5173/r/SHORT")).toBeNull();
    expect(codeFromShared("http://localhost:5173/r/")).toBeNull();
    expect(codeFromShared("http://localhost:5173/rooms/ABCD1234")).toBeNull();
    expect(codeFromShared("")).toBeNull();
  });
});

describe("roomLink", () => {
  it("builds a link from the current origin", () => {
    // This module is browser code, so the test supplies the one global it reaches for rather
    // than pulling in a whole DOM environment for a single string concatenation.
    const original = Reflect.get(globalThis, "location");
    Reflect.set(globalThis, "location", { origin: "https://chat.example.com" });
    try {
      expect(roomLink("ABCD1234")).toBe("https://chat.example.com/r/ABCD1234");
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, "location");
      else Reflect.set(globalThis, "location", original);
    }
  });
});
