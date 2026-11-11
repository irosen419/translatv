// The per user data API under /api/me and /api/account (M5): preferences, a stored glossary,
// call history, contacts, and deleting the account. And safety: blocks, reports, and the owner's
// review of reports under /api/owner.
//
// Beside auth.ts rather than inside it because it is a different surface (what an account HOLDS,
// not how a session is had), and in shared for the same reason auth.ts is: the web client and
// the iOS app speak it too. The zod schema is the server's validation AND the source of the
// types, so the two sides cannot drift. Refusals reuse AuthErrorCode, since every one of them is
// a session or input refusal that code set already names.
//
// Exported with golden fixtures like the WebSocket's: http.ts says which schema goes with which
// route, script/gen_wire.mjs writes shared/wire/http.schema.json, and script/check_wire.mjs
// demands a fixture under shared/wire/fixtures/http/ for every request and response.

import { z } from "zod";
import { MAX_PASSWORD_LENGTH } from "./auth.js";
import { bodyText, dialectCode, glossaryEntry, LIMITS } from "./protocol.js";

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

/**
 * A user's stored dialects. Both nullable: null is "never chosen", which a client answers with
 * its own detection rather than with a value the server made up.
 *
 *   dialect    the dialect they speak in a call, which the pre join picker defaults from.
 *   uiDialect  the dialect the interface is read in. The web client ties the two together by
 *              owner decision, and saves both; a native client is free not to.
 *
 * PUT replaces the whole object, so both fields are required and an unknown key is refused
 * rather than silently dropped.
 */
export const preferences = z
  .object({
    dialect: dialectCode.nullable(),
    uiDialect: dialectCode.nullable(),
  })
  .strict();
export type Preferences = z.infer<typeof preferences>;

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------

/**
 * One stored entry: the wire glossaryEntry, so the SAME cleaning and length limits apply as to a
 * glossary.import, plus a refusal of a term that is empty once cleaned. The wire tolerates an
 * empty term because a room glossary is transient; a stored one would be merged into every room
 * this person ever opens, so a blank entry is refused at the door instead.
 */
const MUST_HAVE_TEXT = { message: "a glossary term and its translation must both have text" };
export const storedGlossaryEntry = glossaryEntry.extend({
  // Fields rather than a refine over the entry, so the exported schema says minLength 1.
  source: bodyText(LIMITS.glossaryTerm, MUST_HAVE_TEXT),
  target: bodyText(LIMITS.glossaryTranslation, MUST_HAVE_TEXT),
});

/** The whole stored glossary. PUT replaces it; an empty list clears it. */
export const glossaryDocument = z.object({
  entries: z.array(storedGlossaryEntry).max(LIMITS.glossaryEntries),
});
export type GlossaryDocument = z.infer<typeof glossaryDocument>;

// ---------------------------------------------------------------------------
// Calls and contacts
// ---------------------------------------------------------------------------

export const CALLS_PAGE_DEFAULT = 20;
export const CALLS_PAGE_MAX = 100;

/** The query string of GET /api/me/calls. `before` is the previous page's nextCursor. */
export const callsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(CALLS_PAGE_MAX).default(CALLS_PAGE_DEFAULT),
  before: z.string().min(1).max(128).optional(),
});
export type CallsQuery = z.input<typeof callsQuery>;

/**
 * The other person on a call, as the viewer sees them.
 *
 * contactId is opaque and PER VIEWER, never the peer's account id: being in a call with someone
 * does not hand you their account id (server/src/rooms/RoomManager.ts, Member.userId). It is
 * stable, so it keys a contact list and matches a call to its contact.
 */
export const callPeer = z.object({
  contactId: z.string(),
  /** Their CURRENT display name, read at request time, not the name they had on the call. */
  displayName: z.string(),
});
export type CallPeer = z.infer<typeof callPeer>;

export const callRecord = z.object({
  id: z.string(),
  /** Null when nobody joined, or when the other account has since been deleted. */
  peer: callPeer.nullable(),
  /** Epoch milliseconds. */
  startedAt: z.number(),
  /** Null while the call is live, or when the server stopped before it could close the row. */
  endedAt: z.number().nullable(),
});
export type CallRecord = z.infer<typeof callRecord>;

export const callsPage = z.object({
  /** Newest first. */
  calls: z.array(callRecord),
  /** Pass as `before` for the next page, or null when there is none. */
  nextCursor: z.string().nullable(),
});
export type CallsPage = z.infer<typeof callsPage>;

/** Someone this account has been on a call with. Derived from call history, never stored. */
export const contact = callPeer.extend({
  lastCallAt: z.number(),
  callCount: z.number().int().positive(),
});
export type Contact = z.infer<typeof contact>;

export const contactsResponse = z.object({
  /** Most recent call first. */
  contacts: z.array(contact),
});
export type ContactsResponse = z.infer<typeof contactsResponse>;

// ---------------------------------------------------------------------------
// Deleting the account
// ---------------------------------------------------------------------------

/**
 * DELETE /api/account. The password again, because an access token alone proves only that this
 * device was signed in within the last fifteen minutes, and deletion cannot be undone.
 *
 * And the id of the account the person is deleting (PublicUser.id), which the server compares
 * with the bearer's. Tabs of one browser share a sign in, so a tab can be showing an account it
 * is no longer signed in as; without the id, a deletion confirmed for one account deleted another
 * (measured in review, with a password the two accounts shared). A mismatch is ACCOUNT_MISMATCH.
 */
export const deleteAccountRequest = z.object({
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  userId: z.string().min(1).max(128),
});
export type DeleteAccountRequest = z.input<typeof deleteAccountRequest>;

// ---------------------------------------------------------------------------
// Safety: blocking, reporting, and the owner's review of reports
// ---------------------------------------------------------------------------
//
// A person is named by their contactId, the same per viewer opaque id call history and contacts
// carry (callPeer above), and never by an account id: being in a call with someone still does not
// hand you their account id. The server resolves a contactId only against the viewer's OWN call
// history (or, to unblock, their own blocks), so a person can block or report only someone they
// have actually been on a call with, and an id typed in from anywhere else names nobody.

/** POST /api/me/blocks and DELETE /api/me/blocks: the person to block or unblock. */
export const contactRef = z
  .object({
    contactId: z.string().min(1).max(64),
  })
  .strict();
export type ContactRef = z.input<typeof contactRef>;

/** Someone this account has blocked. The name is their CURRENT display name, as in contacts. */
export const blockedPerson = callPeer.extend({
  /** Epoch milliseconds. */
  blockedAt: z.number(),
});
export type BlockedPerson = z.infer<typeof blockedPerson>;

/**
 * GET /api/me/blocks, and the answer to blocking and unblocking (the list as it now stands), newest
 * block first. Blocking is idempotent: blocking someone already blocked answers the same list.
 */
export const blocksResponse = z.object({ blocked: z.array(blockedPerson) });
export type BlocksResponse = z.infer<typeof blocksResponse>;

/** Why someone is being reported. A fixed set, so the owner's list can be read at a glance. */
export const REPORT_REASONS = ["harassment", "hate", "sexual_content", "spam_or_scam", "underage", "other"] as const;
export const reportReason = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof reportReason>;

/** The longest free text a report can carry, once cleaned. */
export const REPORT_DETAILS_MAX = 500;

/**
 * POST /api/me/reports.
 *
 * details is the reporter's own words, and user content like a transcript: stored for the owner
 * to read, never logged, and never sent to the person reported. Nothing from the call itself is
 * attached, because nothing said on a call is stored anywhere to attach.
 *
 * alsoBlock blocks the same person in the same transaction as the report, so the two land
 * together or not at all.
 */
export const reportRequest = z.object({
  contactId: z.string().min(1).max(64),
  reason: reportReason,
  details: bodyText(REPORT_DETAILS_MAX).optional(),
  alsoBlock: z.boolean().optional(),
});
export type ReportRequest = z.input<typeof reportRequest>;

/** The answer to a report: its id, and whether the person is now blocked by the reporter. */
export const reportReceipt = z.object({
  id: z.string(),
  blocked: z.boolean(),
});
export type ReportReceipt = z.infer<typeof reportReceipt>;

export const reportStatus = z.enum(["open", "reviewed"]);
export type ReportStatus = z.infer<typeof reportStatus>;

/**
 * An account as the OWNER's report list shows it. The owner runs the server and already holds
 * every account id, so this is the one place an account id is sent on purpose. Null on a report
 * whose account has since been deleted: a report outlives both accounts it names.
 */
export const reportParty = z.object({
  userId: z.string(),
  displayName: z.string(),
});
export type ReportParty = z.infer<typeof reportParty>;

/** One report, as the owner reads it. */
export const ownerReport = z.object({
  id: z.string(),
  reason: reportReason,
  /** The reporter's own words, or null when they gave none. */
  details: z.string().nullable(),
  status: reportStatus,
  /** Epoch milliseconds. */
  createdAt: z.number(),
  /** Epoch milliseconds, or null while open. */
  reviewedAt: z.number().nullable(),
  reporter: reportParty.nullable(),
  reported: reportParty.nullable(),
});
export type OwnerReport = z.infer<typeof ownerReport>;

/** The most reports GET /api/owner/reports answers with, newest first. */
export const REPORTS_LIST_MAX = 200;

/** GET /api/owner/reports. Open reports first, then reviewed, each newest first. */
export const reportsResponse = z.object({ reports: z.array(ownerReport) });
export type ReportsResponse = z.infer<typeof reportsResponse>;

/** POST /api/owner/reports/review: mark one report reviewed. Marking it twice is harmless. */
export const reviewReportRequest = z.object({ id: z.string().min(1).max(64) });
export type ReviewReportRequest = z.input<typeof reviewReportRequest>;
