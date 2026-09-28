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
  glossaryDocument,
  preferences as preferencesSchema,
  type CallsPage,
  type ContactsResponse,
  type GlossaryDocument,
  type GlossaryEntry,
  type Preferences,
} from "@translatv/shared";

import type { AuthResult } from "../auth/service.js";
import { log } from "../log.js";
import { endCall, insertCall, listCalls, listContacts, setCallPeer } from "../store/callHistory.js";
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

export class AccountService implements RoomUserData {
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

  callEnded(callId: string, now: number): void {
    try {
      endCall(this.store, callId, now);
    } catch (error) {
      log.warn("account.call_record_failed", { error: error instanceof Error ? error.message : "unknown" });
    }
  }
}
