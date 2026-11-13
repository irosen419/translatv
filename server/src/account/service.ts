// Per user data (M5): preferences, a stored glossary, call history, and contacts.
//
// Same shape as AuthService: every rule lives here, results rather than exceptions for anything
// a caller can cause, and the HTTP layer (auth/routes.ts) only maps results to status codes.
//
// What is NOT here is as deliberate as what is. Transcripts, chat and room glossaries are never
// persisted: a call leaves behind who, when and for how long, and nothing that was said. That is
// the logging rule's spirit applied to storage, since a table is a log that never rotates.
//
// It is also the socket layer's RoomUserData: ws/server.ts reads a glossary to merge into a room
// and reports when calls start and end. Those methods never throw. A call in progress must not
// fail because its history row could not be written, so a storage error there is logged (as a
// message with no user content) and swallowed.

import { createHash, randomBytes } from "node:crypto";
import {
  callsQuery,
  contactRef,
  LIMITS,
  REPORTS_LIST_MAX,
  reportRequest,
  reviewReportRequest,
  type BlocksResponse,
  type OwnerReport,
  type ReportReceipt,
  type ReportsResponse,
  glossaryDocument,
  preferences as preferencesSchema,
  type CallsPage,
  type ContactsResponse,
  type GlossaryDocument,
  type GlossaryEntry,
  type Preferences,
} from "@translatv/shared";

import type { AuthResult } from "../auth/service.js";
import { mergeNewestFirst, screenCorrection, type ScreenReason } from "./corrections.js";
import { log } from "../log.js";
import { blockedEitherWay, deleteBlock, insertBlock, listBlocks } from "../store/blocks.js";
import { deleteUnansweredCall, endCall, insertCall, listCalls, listContacts, listPeerIds, setCallPeer } from "../store/callHistory.js";
import { findReport, insertReport, listReports, markReviewed, type ReportRow } from "../store/reports.js";
import { findGlossary, replaceGlossary } from "../store/glossaries.js";
import { findPreferences, savePreferences } from "../store/preferences.js";
import type { Store } from "../store/store.js";

/** What the WebSocket layer needs from per user data. An interface so room tests can stub it. */
export interface RoomUserData {
  /** The user's stored glossary, to merge into a room they create or join. */
  glossaryFor(userId: string): readonly GlossaryEntry[];
  /** A user entered a room. Returns the new row's id, or null when it could not be written. */
  callStarted(input: { userId: string; roomHash: string; peerUserId: string | null; now: number }): string | null;
  /** The other person arrived on a call that had nobody on the other end yet. */
  callPeered(callId: string, peerUserId: string): void;
  /** The user left, timed out, or the room ended. */
  callEnded(callId: string, now: number): void;
  /**
   * The user's call ended with nobody ever on the other end: drop its row instead of closing it.
   * A room opened and left alone is not a call with anyone, and listing it as "Nobody joined"
   * filled the history with noise (owner report, 2026-11-13). Optional so a stand in without
   * call history need not implement it.
   */
  callUnanswered?(callId: string): void;
  /**
   * The corrections this user made in a call that just closed, oldest first. Screened, and the
   * survivors saved to THIS user's stored glossary. The caller hands over only the corrections the
   * user made themselves (owner decision C2), which is what keeps the other person out of it.
   */
  saveCorrections(userId: string, corrections: readonly GlossaryEntry[]): void;
  /** Has either account blocked the other? If so they are never in one room together. */
  blockedBetween(a: string, b: string): boolean;
  /**
   * Hear about each block as it is made, so a call the two are already in can be ended. Returns
   * the way to stop listening. Required, so the socket layer cannot be wired without it.
   */
  onBlocked(listener: (blockerId: string, blockedId: string) => void): () => void;
}

const INVALID = { ok: false, error: "INVALID_INPUT" } as const;

/** The (started_at, id) of a page's last row, as an opaque string the client hands back. */
function encodeCursor(startedAt: number, id: string): string {
  return Buffer.from(`${startedAt}.${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { startedAt: number; id: string } | null {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,64})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) return null;
  return { startedAt: Number(match[1]), id: String(match[2]) };
}

/**
 * How one viewer refers to one peer. Opaque and per viewer, so a contact list never carries an
 * account id (see callPeer in shared/src/account.ts). Unkeyed sha256 is enough: both inputs are
 * 128 bit random ids, so the value cannot be walked back to either without already holding it.
 */
export function contactIdFor(viewerId: string, peerId: string): string {
  return createHash("sha256").update(`translatv contact v1\n${viewerId}\n${peerId}`).digest("base64url").slice(0, 22);
}

function toOwnerReport(row: ReportRow): OwnerReport {
  return {
    id: row.id,
    reason: row.reason,
    details: row.details,
    status: row.status,
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
    reporter: row.reporterId !== null && row.reporterName !== null ? { userId: row.reporterId, displayName: row.reporterName } : null,
    reported: row.reportedId !== null && row.reportedName !== null ? { userId: row.reportedId, displayName: row.reportedName } : null,
  };
}

export class AccountService implements RoomUserData {
  private readonly blockListeners = new Set<(blockerId: string, blockedId: string) => void>();

  constructor(private readonly store: Store) {}

  // -------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------

  preferencesFor(userId: string): Preferences {
    return findPreferences(this.store, userId) ?? { dialect: null, uiDialect: null };
  }

  setPreferences(userId: string, body: unknown, now: number): AuthResult<Preferences> {
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) return INVALID;
    savePreferences(this.store, userId, parsed.data, now);
    return { ok: true, value: parsed.data };
  }

  // -------------------------------------------------------------------------
  // Glossary
  // -------------------------------------------------------------------------

  glossaryFor(userId: string): GlossaryEntry[] {
    try {
      return findGlossary(this.store, userId);
    } catch (error) {
      log.error("account.glossary_read_failed", { error: error instanceof Error ? error.message : "unknown" });
      return [];
    }
  }

  setGlossary(userId: string, body: unknown): AuthResult<GlossaryDocument> {
    const parsed = glossaryDocument.safeParse(body);
    if (!parsed.success) return INVALID;
    this.store.transaction(() => replaceGlossary(this.store, userId, parsed.data.entries));
    log.info("account.glossary_saved", { user: userId, count: parsed.data.entries.length });
    return { ok: true, value: parsed.data };
  }

  // -------------------------------------------------------------------------
  // Calls and contacts
  // -------------------------------------------------------------------------

  callsFor(userId: string, query: unknown): AuthResult<CallsPage> {
    const parsed = callsQuery.safeParse(query);
    if (!parsed.success) return INVALID;
    const before = parsed.data.before === undefined ? null : decodeCursor(parsed.data.before);
    if (parsed.data.before !== undefined && before === null) return INVALID;

    // One extra row answers "is there another page" without a count query.
    const rows = listCalls(this.store, userId, parsed.data.limit + 1, before);
    const page = rows.slice(0, parsed.data.limit);
    const last = page[page.length - 1];
    return {
      ok: true,
      value: {
        calls: page.map((row) => ({
          id: row.id,
          peer:
            row.peerUserId !== null && row.peerDisplayName !== null
              ? { contactId: contactIdFor(userId, row.peerUserId), displayName: row.peerDisplayName }
              : null,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
        })),
        nextCursor: rows.length > parsed.data.limit && last ? encodeCursor(last.startedAt, last.id) : null,
      },
    };
  }

  contactsFor(userId: string): ContactsResponse {
    return {
      contacts: listContacts(this.store, userId).map((row) => ({
        contactId: contactIdFor(userId, row.peerUserId),
        displayName: row.displayName,
        lastCallAt: row.lastCallAt,
        callCount: row.callCount,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Safety: blocks and reports
  // -------------------------------------------------------------------------

  /**
   * The account a contactId names, looked up ONLY among the people this viewer has been on a call
   * with. So a contactId lifted from someone else's list, or made up, names nobody, and nobody can
   * be blocked or reported without having actually been in a call with them.
   */
  private peerFor(viewerId: string, contactId: string): string | null {
    return listPeerIds(this.store, viewerId).find((peerId) => contactIdFor(viewerId, peerId) === contactId) ?? null;
  }

  blocksFor(userId: string): BlocksResponse {
    return {
      blocked: listBlocks(this.store, userId).map((row) => ({
        contactId: contactIdFor(userId, row.blockedId),
        displayName: row.displayName,
        blockedAt: row.createdAt,
      })),
    };
  }

  block(userId: string, body: unknown, now: number): AuthResult<BlocksResponse> {
    const parsed = contactRef.safeParse(body);
    if (!parsed.success) return INVALID;
    const peerId = this.peerFor(userId, parsed.data.contactId);
    if (peerId === null) return { ok: false, error: "CONTACT_NOT_FOUND" };
    insertBlock(this.store, userId, peerId, now);
    log.info("account.blocked", { user: userId });
    this.announceBlock(userId, peerId);
    return { ok: true, value: this.blocksFor(userId) };
  }

  unblock(userId: string, body: unknown): AuthResult<BlocksResponse> {
    const parsed = contactRef.safeParse(body);
    if (!parsed.success) return INVALID;
    // Resolved among this account's OWN blocks, which outlive the history rows they came from.
    const blocked = listBlocks(this.store, userId).find((row) => contactIdFor(userId, row.blockedId) === parsed.data.contactId);
    if (!blocked) return { ok: false, error: "CONTACT_NOT_FOUND" };
    deleteBlock(this.store, userId, blocked.blockedId);
    log.info("account.unblocked", { user: userId });
    return { ok: true, value: this.blocksFor(userId) };
  }

  blockedBetween(a: string, b: string): boolean {
    try {
      return blockedEitherWay(this.store, a, b);
    } catch (error) {
      // Unreadable: refuse the pairing rather than risk putting a blocked person in the room.
      log.error("account.block_read_failed", { error: error instanceof Error ? error.message : "unknown" });
      return true;
    }
  }

  onBlocked(listener: (blockerId: string, blockedId: string) => void): () => void {
    this.blockListeners.add(listener);
    return () => this.blockListeners.delete(listener);
  }

  private announceBlock(blockerId: string, blockedId: string): void {
    for (const listener of this.blockListeners) {
      try {
        listener(blockerId, blockedId);
      } catch (error) {
        log.error("account.block_listener_failed", { error: error instanceof Error ? error.message : "unknown" });
      }
    }
  }

  /**
   * Report someone this account has been on a call with. The details are the reporter's own words:
   * stored for the owner, and never logged (log.ts withholds a `details` key too, but nothing here
   * hands it one). With alsoBlock, the block lands in the same transaction as the report.
   */
  report(userId: string, body: unknown, now: number): AuthResult<ReportReceipt> {
    const parsed = reportRequest.safeParse(body);
    if (!parsed.success) return INVALID;
    const peerId = this.peerFor(userId, parsed.data.contactId);
    if (peerId === null) return { ok: false, error: "CONTACT_NOT_FOUND" };
    const id = randomBytes(16).toString("base64url");
    const details = parsed.data.details === undefined || parsed.data.details === "" ? null : parsed.data.details;
    const alsoBlock = parsed.data.alsoBlock === true;
    this.store.transaction(() => {
      insertReport(this.store, { id, reporterId: userId, reportedId: peerId, reason: parsed.data.reason, details, createdAt: now });
      if (alsoBlock) insertBlock(this.store, userId, peerId, now);
    });
    log.info("account.reported", { user: userId, reason: parsed.data.reason, withDetails: details !== null, alsoBlock });
    if (alsoBlock) this.announceBlock(userId, peerId);
    return { ok: true, value: { id, blocked: alsoBlock || this.isBlockedBy(userId, peerId) } };
  }

  private isBlockedBy(blockerId: string, blockedId: string): boolean {
    return listBlocks(this.store, blockerId).some((row) => row.blockedId === blockedId);
  }

  /** The owner's list. The caller (the router) has already checked the caller is the owner. */
  reportsForOwner(): ReportsResponse {
    return { reports: listReports(this.store, REPORTS_LIST_MAX).map(toOwnerReport) };
  }

  reviewReport(body: unknown, now: number): AuthResult<OwnerReport> {
    const parsed = reviewReportRequest.safeParse(body);
    if (!parsed.success) return INVALID;
    if (findReport(this.store, parsed.data.id) === null) return { ok: false, error: "REPORT_NOT_FOUND" };
    markReviewed(this.store, parsed.data.id, now);
    const row = findReport(this.store, parsed.data.id);
    if (row === null) return { ok: false, error: "REPORT_NOT_FOUND" };
    log.info("account.report_reviewed", { report: row.id });
    return { ok: true, value: toOwnerReport(row) };
  }

  // -------------------------------------------------------------------------
  // RoomUserData: called by the socket layer, never throws
  // -------------------------------------------------------------------------

  callStarted(input: { userId: string; roomHash: string; peerUserId: string | null; now: number }): string | null {
    const id = randomBytes(16).toString("base64url");
    try {
      insertCall(this.store, {
        id,
        userId: input.userId,
        roomHash: input.roomHash,
        peerUserId: input.peerUserId,
        startedAt: input.now,
      });
      return id;
    } catch (error) {
      // Most likely the account was deleted between the upgrade and this frame, which the
      // foreign key refuses. The call goes ahead; it simply has no history row.
      log.warn("account.call_record_failed", { error: error instanceof Error ? error.message : "unknown" });
      return null;
    }
  }

  callPeered(callId: string, peerUserId: string): void {
    try {
      setCallPeer(this.store, callId, peerUserId);
    } catch (error) {
      log.warn("account.call_record_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  saveCorrections(userId: string, corrections: readonly GlossaryEntry[]): void {
    if (corrections.length === 0) return;
    const passed: GlossaryEntry[] = [];
    const dropped: Partial<Record<ScreenReason, number>> = {};
    for (const correction of corrections) {
      const verdict = screenCorrection(correction);
      if (verdict.ok) passed.push(verdict.entry);
      else dropped[verdict.reason] = (dropped[verdict.reason] ?? 0) + 1;
    }
    // Counts and reasons only. What was said, and what it was corrected to, never reach the log.
    log.info("account.corrections_screened", { user: userId, saved: passed.length, dropped });
    if (passed.length === 0) return;
    try {
      // Read and write in one transaction, so a half written list never lands. node:sqlite is
      // synchronous, so nothing else in this process runs between the two anyway. A PUT from the
      // saved list is a separate read and write on the client, with no version check, so a save
      // landing between that list's read and its write is lost (a small window, disclosed).
      this.store.transaction(() => {
        const merged = mergeNewestFirst(findGlossary(this.store, userId), passed, LIMITS.glossaryEntries);
        replaceGlossary(this.store, userId, merged);
      });
    } catch (error) {
      // Most likely the account was deleted during the call, and the foreign key refuses rows for
      // it. The transaction rolled back, so nothing is half saved.
      log.warn("account.corrections_save_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  callUnanswered(callId: string): void {
    try {
      deleteUnansweredCall(this.store, callId);
    } catch (error) {
      log.warn("account.call_record_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }

  callEnded(callId: string, now: number): void {
    try {
      endCall(this.store, callId, now);
    } catch (error) {
      log.warn("account.call_record_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }
}
