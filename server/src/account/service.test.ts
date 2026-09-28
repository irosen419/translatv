// Per user data against a real in memory database: preferences, the stored glossary, call
// history and the contacts derived from it. routes.test.ts proves the HTTP mapping, and
// rooms.test.ts proves the WebSocket layer drives the call rows.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LIMITS } from "@translatv/shared";
import { openStore, type Store } from "../store/index.js";
import { insertUser, newUserId } from "../store/users.js";
import { AccountService } from "./service.js";

const NOW = 1_800_000_000_000;

let store: Store;
let account: AccountService;

function user(displayName: string): string {
  const id = newUserId();
  insertUser(store, {
    id,
    email: `${displayName.toLowerCase()}@example.test`,
    passwordHash: "x",
    displayName,
    isOwner: false,
    createdAt: NOW,
  });
  return id;
}

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  account = new AccountService(store);
});

afterEach(() => {
  store.close();
});

const entry = { source: "chamba", target: "job", sourceDialect: "es-MX", targetDialect: "en-US" };

describe("preferences", () => {
  it("reads as never chosen before anything is saved", () => {
    expect(account.preferencesFor(user("Ana"))).toEqual({ dialect: null, uiDialect: null });
  });

  it("round trips, and a second save replaces the first", () => {
    const ana = user("Ana");
    expect(account.setPreferences(ana, { dialect: "es-AR", uiDialect: "es-AR" }, NOW)).toEqual({
      ok: true,
      value: { dialect: "es-AR", uiDialect: "es-AR" },
    });
    expect(account.preferencesFor(ana)).toEqual({ dialect: "es-AR", uiDialect: "es-AR" });
    account.setPreferences(ana, { dialect: "en-US", uiDialect: null }, NOW + 1);
    expect(account.preferencesFor(ana)).toEqual({ dialect: "en-US", uiDialect: null });
  });

  it("refuses an unknown dialect and keeps what was stored", () => {
    const ana = user("Ana");
    account.setPreferences(ana, { dialect: "es-AR", uiDialect: null }, NOW);
    expect(account.setPreferences(ana, { dialect: "xx-XX", uiDialect: null }, NOW)).toEqual({
      ok: false,
      error: "INVALID_INPUT",
    });
    expect(account.preferencesFor(ana).dialect).toBe("es-AR");
  });

  it("is per user", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    account.setPreferences(ana, { dialect: "es-AR", uiDialect: null }, NOW);
    expect(account.preferencesFor(ben)).toEqual({ dialect: null, uiDialect: null });
  });
});

describe("glossary", () => {
  it("is empty to start, and PUT replaces the whole list in order", () => {
    const ana = user("Ana");
    expect(account.glossaryFor(ana)).toEqual([]);
    const second = { ...entry, source: "pibe", target: "kid", sourceDialect: "es-AR" };
    expect(account.setGlossary(ana, { entries: [entry, second] }).ok).toBe(true);
    expect(account.glossaryFor(ana)).toEqual([entry, second]);
    account.setGlossary(ana, { entries: [second] });
    expect(account.glossaryFor(ana)).toEqual([second]);
    account.setGlossary(ana, { entries: [] });
    expect(account.glossaryFor(ana)).toEqual([]);
  });

  it("stores the cleaned text, exactly as a glossary.import would clean it", () => {
    const ana = user("Ana");
    account.setGlossary(ana, { entries: [{ ...entry, source: "  chamba\t" }] });
    expect(account.glossaryFor(ana)[0]?.source).toBe("chamba");
  });

  it("refuses more entries than the wire allows, and an over long term, storing nothing", () => {
    const ana = user("Ana");
    account.setGlossary(ana, { entries: [entry] });
    const tooMany = Array.from({ length: LIMITS.glossaryEntries + 1 }, (_, i) => ({ ...entry, source: `t${i}` }));
    expect(account.setGlossary(ana, { entries: tooMany })).toEqual({ ok: false, error: "INVALID_INPUT" });
    const tooLong = { ...entry, source: "a".repeat(LIMITS.glossaryTerm + 1) };
    expect(account.setGlossary(ana, { entries: [tooLong] })).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(account.glossaryFor(ana)).toEqual([entry]);
  });
});

describe("call history", () => {
  it("records a call, fills in the peer, and closes it", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const call = account.callStarted({ userId: ana, roomHash: "h1", peerUserId: null, now: NOW });
    expect(call).not.toBeNull();
    account.callPeered(call as string, ben);
    account.callEnded(call as string, NOW + 5_000);

    const page = account.callsFor(ana, {});
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.calls).toHaveLength(1);
    expect(page.value.calls[0]).toMatchObject({ startedAt: NOW, endedAt: NOW + 5_000 });
    expect(page.value.calls[0]?.peer?.displayName).toBe("Ben");
    expect(page.value.nextCursor).toBeNull();
  });

  it("stores the room hash it is given, and never needs the code", () => {
    const ana = user("Ana");
    account.callStarted({ userId: ana, roomHash: "abcdef0123456789", peerUserId: null, now: NOW });
    const row = store.db.prepare("SELECT room_hash FROM call_history").get();
    expect(row).toEqual({ room_hash: "abcdef0123456789" });
  });

  it("closes a row once: a later end does not move it", () => {
    const ana = user("Ana");
    const call = account.callStarted({ userId: ana, roomHash: "h", peerUserId: null, now: NOW }) as string;
    account.callEnded(call, NOW + 1);
    account.callEnded(call, NOW + 99);
    const page = account.callsFor(ana, {});
    expect(page.ok && page.value.calls[0]?.endedAt).toBe(NOW + 1);
  });

  it("pages newest first, with a cursor that carries on where the last page stopped", () => {
    const ana = user("Ana");
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      ids.push(account.callStarted({ userId: ana, roomHash: `h${i}`, peerUserId: null, now: NOW + i }) as string);
    }
    // Two calls in the same millisecond still page deterministically.
    ids.push(account.callStarted({ userId: ana, roomHash: "tie", peerUserId: null, now: NOW + 4 }) as string);

    const seen: string[] = [];
    let before: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = account.callsFor(ana, { limit: "2", ...(before ? { before } : {}) });
      if (!page.ok) throw new Error(page.error);
      seen.push(...page.value.calls.map((c) => c.id));
      const starts = page.value.calls.map((c) => c.startedAt);
      expect([...starts].sort((a, b) => b - a)).toEqual(starts);
      if (page.value.nextCursor === null) break;
      before = page.value.nextCursor;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it("refuses a malformed cursor or page size", () => {
    const ana = user("Ana");
    expect(account.callsFor(ana, { before: "not a cursor" })).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(account.callsFor(ana, { limit: "1000" })).toEqual({ ok: false, error: "INVALID_INPUT" });
  });

  it("shows only the caller's own calls", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    account.callStarted({ userId: ana, roomHash: "h", peerUserId: ben, now: NOW });
    const page = account.callsFor(ben, {});
    expect(page.ok && page.value.calls).toEqual([]);
  });

  it("never lets a storage failure escape into the call: a vanished user starts no row", () => {
    expect(account.callStarted({ userId: "no-such-user", roomHash: "h", peerUserId: null, now: NOW })).toBeNull();
  });
});

describe("contacts", () => {
  it("are derived from call history: distinct peers, most recent call first, current names", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    account.callStarted({ userId: ana, roomHash: "a", peerUserId: ben, now: NOW });
    account.callStarted({ userId: ana, roomHash: "b", peerUserId: cam, now: NOW + 10 });
    account.callStarted({ userId: ana, roomHash: "c", peerUserId: ben, now: NOW + 20 });
    // A call nobody joined is history but not a contact.
    account.callStarted({ userId: ana, roomHash: "d", peerUserId: null, now: NOW + 30 });

    store.db.prepare("UPDATE users SET display_name = 'Benjamín' WHERE id = ?").run(ben);

    const { contacts } = account.contactsFor(ana);
    expect(contacts.map((c) => [c.displayName, c.lastCallAt, c.callCount])).toEqual([
      ["Benjamín", NOW + 20, 2],
      ["Cam", NOW + 10, 1],
    ]);
  });

  it("identify a contact per viewer, never by account id, and match their calls", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    account.callStarted({ userId: ana, roomHash: "a", peerUserId: cam, now: NOW });
    account.callStarted({ userId: ben, roomHash: "b", peerUserId: cam, now: NOW });

    const forAna = account.contactsFor(ana).contacts[0];
    const forBen = account.contactsFor(ben).contacts[0];
    expect(forAna?.contactId).not.toBe(cam);
    expect(forAna?.contactId).not.toBe(forBen?.contactId);
    const page = account.callsFor(ana, {});
    expect(page.ok && page.value.calls[0]?.peer?.contactId).toBe(forAna?.contactId);
  });

  it("are not stored anywhere: there is no contacts table", () => {
    const tables = store.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r["name"]));
    expect(tables.some((t) => t.includes("contact"))).toBe(false);
  });
});
