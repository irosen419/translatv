// The per user data API under /api/me and /api/account (M5): preferences, a stored glossary,
// call history, contacts, and deleting the account.
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
