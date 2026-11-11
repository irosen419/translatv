// Blocks and reports against a real in memory database. routes.test.ts proves the HTTP mapping,
// the owner gate and the per user report limit; rooms.test.ts proves a block keeps two people out
// of one room and ends a call they are already in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openStore, type Store } from "../store/index.js";
import { deleteUser, insertUser, newUserId } from "../store/users.js";
import { AccountService, contactIdFor } from "./service.js";

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

/** Ana and Ben have been on a call together, so each can name the other by contactId. */
function called(a: string, b: string, at = NOW): void {
  account.callStarted({ userId: a, roomHash: "h", peerUserId: b, now: at });
  account.callStarted({ userId: b, roomHash: "h", peerUserId: a, now: at });
}

function reportRows(): Array<Record<string, unknown>> {
  return store.db.prepare("SELECT * FROM reports ORDER BY created_at").all() as Array<Record<string, unknown>>;
}

function blockRows(): Array<Record<string, unknown>> {
  return store.db.prepare("SELECT * FROM blocks").all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  store = openStore({ path: ":memory:" });
  account = new AccountService(store);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
});

describe("blocking", () => {
  it("blocks someone this account has been on a call with, by contactId, and lists them", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const result = account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW + 5);
    expect(result).toEqual({
      ok: true,
      value: { blocked: [{ contactId: contactIdFor(ana, ben), displayName: "Ben", blockedAt: NOW + 5 }] },
    });
    expect(account.blocksFor(ana)).toEqual(result.ok ? result.value : null);
  });

  it("cannot block a stranger: a contactId outside this account's own history names nobody", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    called(ben, cam);
    // Ben's id for Cam is a real contactId, just not one of Ana's.
    expect(account.block(ana, { contactId: contactIdFor(ben, cam) }, NOW)).toEqual({ ok: false, error: "CONTACT_NOT_FOUND" });
    expect(account.block(ana, { contactId: contactIdFor(ana, cam) }, NOW)).toEqual({ ok: false, error: "CONTACT_NOT_FOUND" });
    expect(account.block(ana, { contactId: "made-up" }, NOW)).toEqual({ ok: false, error: "CONTACT_NOT_FOUND" });
    expect(blockRows()).toEqual([]);
  });

  it("refuses a body that does not parse", () => {
    const ana = user("Ana");
    expect(account.block(ana, { contactId: "" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(account.block(ana, { userId: "x" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT" });
  });

  it("is idempotent, and keeps the first time", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW + 9);
    expect(blockRows()).toHaveLength(1);
    expect(account.blocksFor(ana).blocked[0]?.blockedAt).toBe(NOW);
  });

  it("holds in either direction", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    called(ana, ben);
    expect(account.blockedBetween(ana, ben)).toBe(false);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(account.blockedBetween(ana, ben)).toBe(true);
    expect(account.blockedBetween(ben, ana)).toBe(true);
    expect(account.blockedBetween(ana, cam)).toBe(false);
  });

  it("is not visible to the person blocked: their blocks list and contacts are unchanged", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(account.blocksFor(ben)).toEqual({ blocked: [] });
    expect(account.contactsFor(ben).contacts.map((c) => c.displayName)).toEqual(["Ana"]);
  });

  it("takes the blocked person out of the blocker's contacts, and leaves the call history standing", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    called(ana, ben);
    called(ana, cam, NOW + 1);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW + 2);
    expect(account.contactsFor(ana).contacts.map((c) => c.displayName)).toEqual(["Cam"]);
    const calls = account.callsFor(ana, {});
    expect(calls.ok && calls.value.calls.map((c) => c.peer?.displayName)).toEqual(["Cam", "Ben"]);
  });

  it("tells a listener who blocked whom, so a call they share can be ended", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const heard: Array<[string, string]> = [];
    const stop = account.onBlocked((blocker, blocked) => heard.push([blocker, blocked]));
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(heard).toEqual([[ana, ben]]);
    stop();
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(heard).toHaveLength(1);
  });

  it("does not tell a listener about a refused block", () => {
    const ana = user("Ana");
    const heard: unknown[] = [];
    account.onBlocked((...args) => heard.push(args));
    account.block(ana, { contactId: "nobody" }, NOW);
    expect(heard).toEqual([]);
  });
});

describe("unblocking", () => {
  it("removes a block by the same contactId", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(account.unblock(ana, { contactId: contactIdFor(ana, ben) })).toEqual({ ok: true, value: { blocked: [] } });
    expect(account.blockedBetween(ana, ben)).toBe(false);
    expect(account.contactsFor(ana).contacts.map((c) => c.displayName)).toEqual(["Ben"]);
  });

  it("answers CONTACT_NOT_FOUND for someone this account has not blocked", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    expect(account.unblock(ana, { contactId: contactIdFor(ana, ben) })).toEqual({ ok: false, error: "CONTACT_NOT_FOUND" });
  });

  it("cannot lift a block someone else made", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    expect(account.unblock(ben, { contactId: contactIdFor(ben, ana) })).toEqual({ ok: false, error: "CONTACT_NOT_FOUND" });
    expect(account.blockedBetween(ana, ben)).toBe(true);
  });
});

describe("reporting", () => {
  it("stores a report about someone this account has been on a call with", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const result = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "harassment", details: "  rude  " }, NOW);
    expect(result.ok && result.value.blocked).toBe(false);
    const rows = reportRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: result.ok ? result.value.id : "",
      reporter_id: ana,
      reported_id: ben,
      reason: "harassment",
      details: "rude",
      status: "open",
      created_at: NOW,
      reviewed_at: null,
    });
    expect(account.blockedBetween(ana, ben)).toBe(false);
  });

  it("stores no details as null, and blank details as null", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.report(ana, { contactId: contactIdFor(ana, ben), reason: "spam_or_scam" }, NOW);
    account.report(ana, { contactId: contactIdFor(ana, ben), reason: "spam_or_scam", details: "   " }, NOW + 1);
    expect(reportRows().map((r) => r["details"])).toEqual([null, null]);
  });

  it("cannot report a stranger", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    called(ben, cam);
    expect(account.report(ana, { contactId: contactIdFor(ben, cam), reason: "hate" }, NOW)).toEqual({
      ok: false,
      error: "CONTACT_NOT_FOUND",
    });
    expect(account.report(ana, { contactId: contactIdFor(ana, cam), reason: "hate" }, NOW)).toEqual({
      ok: false,
      error: "CONTACT_NOT_FOUND",
    });
    expect(reportRows()).toEqual([]);
  });

  it("refuses an unknown reason and over long details", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const contactId = contactIdFor(ana, ben);
    expect(account.report(ana, { contactId, reason: "rude" }, NOW)).toEqual({ ok: false, error: "INVALID_INPUT" });
    expect(account.report(ana, { contactId, reason: "other", details: "a".repeat(501) }, NOW)).toEqual({
      ok: false,
      error: "INVALID_INPUT",
    });
  });

  it("can still report someone after blocking them", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    const result = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "other" }, NOW + 1);
    expect(result).toMatchObject({ ok: true, value: { blocked: true } });
  });

  it("blocks in the same breath when asked, and says so", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const heard: Array<[string, string]> = [];
    account.onBlocked((a, b) => heard.push([a, b]));
    const result = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "underage", alsoBlock: true }, NOW);
    expect(result).toMatchObject({ ok: true, value: { blocked: true } });
    expect(account.blockedBetween(ana, ben)).toBe(true);
    expect(heard).toEqual([[ana, ben]]);
  });

  it("lands the report and the block together or not at all", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    store.db.exec(
      "CREATE TEMP TRIGGER no_blocks BEFORE INSERT ON blocks BEGIN SELECT RAISE(ABORT, 'refused for the test'); END",
    );
    expect(() =>
      account.report(ana, { contactId: contactIdFor(ana, ben), reason: "hate", alsoBlock: true }, NOW),
    ).toThrow(/refused for the test/);
    expect(reportRows()).toEqual([]);
    expect(blockRows()).toEqual([]);
  });

  it("never hands the details, or the reporter's words in any form, to the logger", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const lines: string[] = [];
    for (const method of ["log", "warn", "error", "info"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      });
    }
    const secret = "the words only the owner may read";
    account.report(ana, { contactId: contactIdFor(ana, ben), reason: "other", details: secret, alsoBlock: true }, NOW);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("the words");
  });
});

describe("deleting an account", () => {
  it("removes every block that names it, in either direction", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    const cam = user("Cam");
    called(ana, ben);
    called(cam, ana);
    account.block(ana, { contactId: contactIdFor(ana, ben) }, NOW);
    account.block(cam, { contactId: contactIdFor(cam, ana) }, NOW);
    expect(blockRows()).toHaveLength(2);
    deleteUser(store, ana);
    expect(blockRows()).toEqual([]);
  });

  it("keeps a report the deleted account made, with the reporter gone from it", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.report(ana, { contactId: contactIdFor(ana, ben), reason: "hate", details: "slurs" }, NOW);
    deleteUser(store, ana);
    expect(reportRows()).toEqual([expect.objectContaining({ reporter_id: null, reported_id: ben, details: "slurs" })]);
    expect(account.reportsForOwner().reports[0]).toMatchObject({ reporter: null, reported: { userId: ben, displayName: "Ben" } });
  });

  it("keeps a report about the deleted account, with the account gone from it", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    account.report(ana, { contactId: contactIdFor(ana, ben), reason: "hate" }, NOW);
    deleteUser(store, ben);
    expect(reportRows()).toEqual([expect.objectContaining({ reporter_id: ana, reported_id: null, reason: "hate" })]);
  });
});

describe("the owner's review", () => {
  it("lists open reports before reviewed ones, each newest first, with both parties named", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const first = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "hate" }, NOW);
    const second = account.report(ben, { contactId: contactIdFor(ben, ana), reason: "spam_or_scam", details: "links" }, NOW + 1);
    const third = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "other" }, NOW + 2);
    if (!first.ok || !second.ok || !third.ok) throw new Error("setup");
    account.reviewReport({ id: third.value.id }, NOW + 3);
    const { reports } = account.reportsForOwner();
    expect(reports.map((r) => r.id)).toEqual([second.value.id, first.value.id, third.value.id]);
    expect(reports[0]).toEqual({
      id: second.value.id,
      reason: "spam_or_scam",
      details: "links",
      status: "open",
      createdAt: NOW + 1,
      reviewedAt: null,
      reporter: { userId: ben, displayName: "Ben" },
      reported: { userId: ana, displayName: "Ana" },
    });
    expect(reports[2]).toMatchObject({ status: "reviewed", reviewedAt: NOW + 3 });
  });

  it("marks a report reviewed once, and answers the report", () => {
    const ana = user("Ana");
    const ben = user("Ben");
    called(ana, ben);
    const made = account.report(ana, { contactId: contactIdFor(ana, ben), reason: "hate" }, NOW);
    if (!made.ok) throw new Error("setup");
    const reviewed = account.reviewReport({ id: made.value.id }, NOW + 1);
    expect(reviewed).toMatchObject({ ok: true, value: { id: made.value.id, status: "reviewed", reviewedAt: NOW + 1 } });
    // A second review keeps the first time.
    expect(account.reviewReport({ id: made.value.id }, NOW + 9)).toMatchObject({ ok: true, value: { reviewedAt: NOW + 1 } });
  });

  it("answers REPORT_NOT_FOUND for an id that is not a report, and INVALID_INPUT for no id", () => {
    expect(account.reviewReport({ id: "nope" }, NOW)).toEqual({ ok: false, error: "REPORT_NOT_FOUND" });
    expect(account.reviewReport({}, NOW)).toEqual({ ok: false, error: "INVALID_INPUT" });
  });
});
