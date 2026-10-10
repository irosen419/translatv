# Handoff: the iOS contract and corrections pull requests

Written 2026-09-29 by reading the code on `main` at a8d1828. Two pull requests come next, and
each part below stands on its own. [`HANDOFF.md`](HANDOFF.md) has the wider picture; this file
is the working brief. Line numbers will drift; the names will not.

**Decided 2026-10-09.** The owner took every recommendation below ("All recommended"), so A1,
A2 and C1 to C6 are settled. [`HANDOFF-AGENT.md`](HANDOFF-AGENT.md) spells out each decision,
records every review so far, and has the prompt that starts each pull request.

## Before either one

- **Read [`CLAUDE.md`](https://github.com/irosen419/translatv/blob/main/CLAUDE.md) first.** It is the contract, and both pull requests run
  into it. The rules that bite here:
  - no em or en dashes anywhere (`npm run check:dashes`);
  - the zod schemas in `shared/` are the single source of truth for every message and request,
    and the server validates with them;
  - the logger never records transcript, chat, username or glossary text (`FORBIDDEN_KEYS` in
    `server/src/log.ts`);
  - "Transcripts, chat and room glossaries are NEVER persisted" (the per user data paragraph),
    guarded by the test "persists no transcript and no chat anywhere" in
    `server/src/account/rooms.test.ts`;
  - migrations are append only;
  - every copy key is in `en.json` and `es.json`, and a regional file overrides only what
    differs (`npm run check:copy`, `client/src/i18n/copy.test.ts`);
  - TDD: a behavior change arrives with a test that fails without it.
- **Branches.** Each pull request gets its own branch cut from `main`. Never commit to `main`.
  Run `git pull --rebase` before committing, and treat a push that would need force as a stop to
  report.
- **Gates.** Run `npm run check` (dashes, copy, wire, spend view, typecheck, the TypeScript and
  Python suites), then `npm run build`, `npm run check:secrets`, `npm run e2e`, and the CI
  `docker` job. CI runs `check`, `e2e` and `docker`.
- **Review.** The `/review-loop` skill (`.claude/skills/review-loop/SKILL.md`) runs an
  adversarial review, and it was worth it on #1 and #3. It has been on `main` since 2026-09-30,
  so a session started from `main` can run it.
- **Merging.** The owner merges both. Neither spends money as scoped here. If the corrections
  screen ever calls a model, that pull request spends, and CLAUDE.md's spend gate holds it.
- **Order.** The two are independent and can run in parallel. The one thing both touch is the
  glossary entry's `source` length, covered next.

## The shared snag: a correction's source is a whole utterance

`RoomSession.correct` (`server/src/ws/RoomSession.ts:153-169`) turns a correction into a room
glossary entry whose `source` is the corrected line's full text (`line.text`). A line can be up
to 2000 characters (`LIMITS.transcript`), but `glossaryEntry.source` allows 200
(`LIMITS.glossaryTerm`) on everything a client sends. So:

- the server already sends `glossary.updated` frames and room snapshots whose sources break the
  schema's own limit;
- saving a correction to an account as it is would store a whole utterance, often the other
  person's words. The persistence rule forbids that, and the stored glossary's 200 character
  limit would refuse it anyway;
- the prompt caps the glossary's count at 40 but not its length (`server/src/translate/prompt.ts`,
  `GLOSSARY_MAX` and the fenced block), so 40 such entries can add about 96,000 characters to
  every translation request.

The corrections pull request is where this gets fixed (decision C1). Until it lands, the
contract pull request must not publish a 200 character limit on glossary entries the server
sends. It should either publish what the server really sends, or give the client and server
shapes separate schemas.

## Part A: the iOS contract

### Why

The iOS app decodes the server's messages with hand written Swift `Codable` types. D7 in
[`docs/PLAN.md`](https://github.com/irosen419/translatv/blob/main/docs/PLAN.md) allows that only because every type is checked against golden fixtures
read in place from `shared/wire/`: "A hand copy that nothing checks is forbidden." Today that
holds for the WebSocket, with gaps, and not at all for the HTTP account API. #1's description
recorded both:

> `schema.json` is lossy, and the HTTP account API has no exported schema. Limits and enums
> (dialect codes, username length) export as bare strings, and Ajv's strict mode refuses the
> file (`protocolVersion` keyword). `shared/src/auth.ts` and `account.ts` have no exported schema
> or fixtures, which PLAN D7 forbids for the iOS app.

> `DELETE /api/account`'s body changed without an API version. PROTOCOL_VERSION covers the socket
> only, so a tab loaded before a deploy gets a 400 on delete. [...] The HTTP schema follow-up
> should carry a version.

The owner decided on 2026-09-28 that this is a new branch and pull request after #1, and that
it comes next. It unblocks the iOS milestones M7 and M9.

### What exists

- **The WebSocket contract.**
  - Everything is zod: `clientMessage` has 16 members and `serverMessage` 19
    (`shared/src/protocol.ts`). `PROTOCOL_VERSION` is 2, with its bump rule beside it, and
    `/healthz` serves it (`server/src/http.ts`).
  - `script/gen_wire.mjs` (`npm run gen:wire`) generates `shared/wire/schema.json` with
    zod-to-json-schema 3.24.6 (`target: "jsonSchema7"`, `effectStrategy: "input"`). It adds a
    nonstandard top level `"protocolVersion": 2`, the keyword Ajv's strict mode refuses.
  - `shared/wire/fixtures/{client,server}/` holds 35 golden fixtures, with an `index.json`.
    `npm run check:wire` (`script/check_wire.mjs`) fails when:
    - a fixture does not parse to itself;
    - a union member has no fixture;
    - the index disagrees with the files;
    - the committed schema is stale.

    The tests are `shared/src/wire.test.ts` and `script/check_wire.test.mjs`.
- **What the export loses.**
  - **Dialects.** `dialectCode` is a `.refine` over a string, so it exports as
    `{"type": "string"}`. Four dialect fields the server sends are plain `z.string()` even in
    zod: `member.dialect`, `srcDialect`, `peer.updated`'s `dialect`, and
    `translation.result`'s `targetDialect`. The codes are in `shared/src/languages.ts`
    (`DIALECT_CODES`): en-US, en-GB, es-AR, es-MX, es-ES and es-CO.
  - **Text limits.** `bodyText` and `username` enforce their limits in a `.refine` after a
    `.transform`, and the export drops both. As a result, no `maxLength` of 24, 200, 400 or 2000
    appears in the schema. Limits written as a plain `.min`, `.max` or `.regex` do survive: the
    resume token, SDP, line id, the 40 item import, and the room code.
  - **Wire constants the app also needs.** None of these is exported:
    - `WS_PATH`;
    - `WS_SUBPROTOCOL` ("translatv.v1", which has nothing to do with PROTOCOL_VERSION 2);
    - `WS_BEARER_PREFIX`;
    - the `CLOSE` codes;
    - `LIMITS`.
- **The HTTP account API** (`server/src/auth/routes.ts`, mounted at `/api`).
  - **Routes.** There are 12:
    - signup, login, refresh, logout and me under `/api/auth`;
    - `POST /api/invites` and `DELETE /api/account`;
    - under `/api/me`: preferences (GET, PUT), glossary (GET, PUT), calls and contacts.
  - **Validation.** Request schemas are zod in `shared/src/auth.ts` and `shared/src/account.ts`,
    and the services validate with them. Responses are typed but never validated at runtime,
    and the web client mostly casts them.
  - **Missing schemas.** Nothing describes:
    - the `{ user }` wrapper of `GET /api/auth/me`;
    - the `/healthz` body;
    - two error codes. The error body is `{ error: code }`, and the router's own `NOT_FOUND`
      and `INTERNAL` are not in `authErrorCode`.
  - **Versioning.** There is none: no path prefix, no header, no field.
  - **Fixtures and export.** There are none. The comment at the top of `shared/src/account.ts`
    says so, and says `check_wire.mjs` needs an HTTP section first.
- **Stale docs to correct in passing.**
  - The Tests section of `CLAUDE.md`, and `TESTING.md`, describe `npm run check` without
    `check:wire` and `check:spend-view`.
  - `PLAN.md` says 30 fixtures; there are 35.
  - D7's prerequisite still calls `ServerMessage` a plain union.
  - M3 promised a `whoami` route; it is `GET /api/auth/me`.

### What to build

1. **Make `schema.json` say what the zod schemas enforce.**
   - **Dialects.** Dialect codes become an enum everywhere a dialect crosses the wire, the four
     server sent fields included.
   - **Text limits.** Add `maxLength` for every text limit, without changing what the server
     accepts: validation still runs on the cleaned value. There are two ways to do it:
     - post-process the generated schema from `LIMITS`, with a test that each limited field
       carries its number;
     - restructure the zod so the generator can see the limit.

     Either way, note that JSON Schema counts code points, while JavaScript's `.length` counts
     UTF-16 units.
   - **Glossary entries.** Mind the shared snag above: publish a limit only where the server
     keeps it on what it sends.
   - **Ajv strict mode.** The schema must compile under it. Move `protocolVersion` somewhere
     standard, for example `$comment` or a small generated `version.json`. Add a test that
     compiles the schema in strict mode, which needs Ajv as a dev dependency (decision A2).
   - **Wire constants.** Export them (path, subprotocol, bearer prefix, close codes and
     limits) as a generated JSON file beside the schema, so Swift reads them in place too.
2. **Give the HTTP account API the same treatment.**
   - **Schemas.** Put a schema for every request and response, errors included, in `shared/`.
     Add the missing ones: `me`, the error body with every code, and `/healthz`.
   - **Export and fixtures.** Generate a JSON Schema and a fixture for every request and
     response. Put them under `shared/wire/`, so the macOS job's path filter (D12) sees them.
   - **The check.** `check:wire`, or a sibling in `npm run check`, covers them as it covers the
     socket: every route has fixtures, each parses to itself, and the schema is current.
   - **The untested join.** A fixture that parses the schema does not prove the server sends
     that shape. Make `server/src/auth/routes.test.ts` parse every real response with the
     exported schemas.
3. **A version for the account API** (decision A1).

**Out of scope:**
- any Swift or `ios/` work, which is M7 onward;
- changing any route's behavior;
- corrections.

### Decisions for the owner

**Decided 2026-10-09: the recommended option for each.**

- **A1. How the account API is versioned.**
  - **Recommended:** an `API_VERSION` constant in `shared/`, with the same bump rule as
    `PROTOCOL_VERSION`. `/healthz` serves it beside the socket's version, and the exported schema
    carries it. There is no path change: the web client ships with the server, and the app reads
    `/healthz` when it starts.
  - **A `/api/v1` path prefix:** every client path changes, and old paths need a redirect or a
    break.
  - **A version header** on every response.
- **A2. Ajv as a dev dependency,** for the strict mode test. Recommended: yes, dev only.

### Done when

- `npm run check` fails on each of these:
  - a fixture with a dialect outside the enum;
  - a fixture with text over its limit;
  - a route with no fixture;
  - a stale HTTP schema;
  - a real route response that does not parse.
- Ajv's strict mode compiles both schemas.
- Tests pin that the four server sent dialect fields and every text limit appear in the export.
- `/healthz` reports the account API version, pinned the way `http.test.ts` pins the socket's.

### Kickoff prompt

In [`HANDOFF-AGENT.md`](HANDOFF-AGENT.md#kickoff-prompts), with the owner's decisions filled in.

## Part B: corrections

### Decisions already made

- **Corrections are saved.** The owner, 2026-09-28: "corrections should be saved overall", with
  "a way to filter out malicious corrections for sure". The owner asked whether screening should
  be "a nightly job? Or a post-call job".
- **Nobody downloads transcripts.** The owner, 2026-09-28: "no one should be able to download
  the transcript from the chatroom anymore". "Load corrections from a past chat" reads that
  download, so it goes too.
- **Recommended, not yet confirmed** (`HANDOFF.md`, section 8): screen after each call, by rules
  only, which costs nothing. Save to an account only the corrections its own owner made.

### What exists

- **Making a correction.**
  - The fix button shows on every translated line, your own and the other person's
    (`client/src/components/TranscriptPanel.tsx`). `CorrectionDialog` caps its input at 400.
  - It sends `glossary.correct { lineId, correctedTranslation }` (`shared/src/protocol.ts`). An
    empty string passes the schema.
  - The panel renders only on wide screens (`Room.tsx`, narrow below 860 pixels), so phones
    cannot correct at all.
- **On the server.**
  - `handleCorrect` (`server/src/ws/server.ts`) calls `RoomSession.correct` with the corrector's
    dialect. It then sends both people `translation.result` (origin "correction") and
    `glossary.updated`.
  - `correct` adds a room glossary entry: the line's full text as `source`, the correction as
    `target`, the line's dialect, and the corrector's dialect as the target. `addGlossaryEntry`
    dedupes on the source, puts the newest first, and keeps 40.
  - Anyone in the room can correct any of the last 500 lines. A speaker who corrects their own
    line makes an entry whose target dialect equals its source dialect.
  - **Who corrected is thrown away.** The connection knows its account (`connection.userId`),
    but `correct` takes no author, and `GlossaryEntry` has no author field.
  - The room glossary also mixes in `glossary.import` entries and both people's stored
    glossaries, so where an entry came from cannot be recovered later.
  - It lives in memory only and dies with the room.
- **Into the prompt.** Corrections are fenced off as data (`server/src/translate/prompt.ts`), and
  `sanitizeForPrompt` strips the fence tags. Only the count is capped. There is no length cap
  per entry, and no filter by dialect pair.
- **Account storage.** There is no corrections store. What #1 added, and what `HANDOFF.md` calls
  "a list of corrections", is the stored glossary:
  - the table `user_glossary` (migration 7, `server/src/store/migrations.ts`), with no length
    checks, by design;
  - `GET` and `PUT /api/me/glossary`: up to 40 entries of 200 and 400 characters
    (`storedGlossaryEntry` in `shared/src/account.ts`), and an empty term is refused;
  - it merges into a room on create and join, but not on resume, through the same path as
    `glossary.import` (`mergeStoredGlossary` in `server.ts`);
  - the web client never calls these routes.
- **When a call ends** (`server/src/ws/server.ts`).
  - **End:** `handleEnd` calls `endRoom`, which closes each member's call, then deletes the
    session.
  - **Leave:** `handleLeave`. A host leaving ends the room.
  - **Drop:** a 60 second grace (`RoomManager.ts`), then the 5 second sweep releases the seat or
    destroys the room.
  - **The hook:** `closeCall` calls `RoomUserData.callEnded` for the account, and every
    `closeCall` site runs before the session is deleted. That is the natural hook for an after
    call job.
  - **Shutdown:** it closes calls but processes no sessions.
- **Download and load, which both go.**
  - **Download.**
    - The `.txt` and `.json` buttons are in `TranscriptPanel.tsx`; `canExport` is hard coded
      true in `Room.tsx`.
    - `client/src/lib/transcript.ts` holds `buildExport`, `toPlainText` and `download`.
    - The ended screen offers no download, and phones have no panel.
  - **Load.**
    - The button and file input are in `client/src/components/PreJoin.tsx` (`onFile`), and
      `parseImport` is in `transcript.ts`.
    - `App.tsx`'s `pendingGlossary` is the web client's only use of `glossary.import`.
  - **Export-only code.** The client store's `glossary` state exists only for the export
    (`client/src/state/store.ts`, and its reads in `Room.tsx`).
  - **Copy keys to remove,** in `en.json` and `es.json`:
    - `prejoin.glossary.load`, `prejoin.glossary.loaded.one` and `.many`;
    - `import.notJson`, `import.notExport`, `import.tooNew`, `import.noGlossary` and
      `import.noUsable`;
    - `panel.export.txt` and `panel.export.json`;
    - `export.header`, `export.exportedAt`, `export.participants`, `export.original`,
      `export.notTranslated` and `export.glossary`.

    `es-AR.json` and `es-CO.json` override some of them, and `PINNED_OVERRIDES` in `copy.test.ts`
    pins several.
  - **Keys to reword, not remove.** Two kept keys promise the download: `correct.body` ("It also
    travels in the .json download") and `room.end.body` ("Download the transcript first").
  - **Tests and comments.** `client/src/lib/transcript.test.ts` covers the removed code. The e2e
    checks that "both export formats are offered" (`script/e2e.mjs`). Server comments justify
    code by the download: the top of `RoomSession.ts`, and `endRoom` in `server.ts`.

### Decisions for the owner, before building

**Decided 2026-10-09: the recommended option for each.**

- **C1. What a saved correction is.** Today it is a whole utterance, often the other person's
  words (the shared snag). Saving that as it is would persist transcript text, which CLAUDE.md
  forbids, and the stored glossary's 200 character term would refuse it anyway. The options:
  - **(a) Recommended: corrections become term level.** The dialog asks for the phrase and its
    fix, up to 200 and 400 characters, prefilled from the line. Each saved entry is then a real
    glossary term, reusable in the next call. It fits the stored glossary, and it ends the
    prompt size problem.
  - (b) Save only corrections whose whole line fits in 200 characters. That still stores the
    other person's words.
  - (c) Amend the persistence rule in CLAUDE.md.
- **C2. Whose corrections an account keeps.**
  - **Recommended:** only its owner's. The server records the author in `handleCorrect`, since
    the connection already knows its account. The other person's corrections still apply during
    the call, and never reach your account.
  - **Also recommended:** show the fix button only on the other person's lines, the translation
    you actually read. That ends the entries whose target dialect equals their source.
- **C3. Where they are saved.** Recommended: the stored glossary. It already loads into every
  call, and it has its routes and limits. Still open is what happens at 40 entries; recommended:
  the newest wins, as in the room.
- **C4. When.** Recommended: after each call, from `closeCall`, before the session is deleted. A
  nightly job leaves them missing until the next day.
- **C5. How they are screened.** Recommended: rules only, which cost nothing. Candidate rules:
  - drop an empty, identical or over length pair;
  - drop control and formatting characters;
  - drop text that reads as instructions to the model rather than a term. The prompt already
    fences it off, so this is a second lock;
  - require the pair's dialects to match the direction it was read in.

  Rules struggle with a flipped meaning, such as "sí" saved as "no". The backstop is showing each
  person their saved entries, with a delete.

  A screen that asks a model costs about one small request per call. That is spend: it goes
  through the ledger, and CLAUDE.md's spend gate holds the pull request for the owner.
- **C6. The `glossary.import` message.** The web client stops sending it once loading goes.
  Recommended: leave it in the protocol. Removing it is a wire change, and the server merges
  stored glossaries through the same path.

### What to build, once decided

1. Record the author of each correction on the server.
2. After each call, screen that account's own corrections and add the survivors to its stored
   glossary.
3. Change the dialog per C1, and the button per C2.
4. Add a place to see and delete saved entries, since it is the backstop for what rules cannot
   catch. Phones have no correction UI today; say whether this pull request adds one or leaves
   it out.
5. Remove the transcript download and "Load corrections from a past chat": everything listed
   above.
   - The code.
   - The copy keys: base files, regional files, and `PINNED_OVERRIDES`.
   - The tests, and the e2e check.

   Reword `correct.body`, `room.end.body`, and the server comments that cite the download.
6. **Logging.** `FORBIDDEN_KEYS` does not cover `source`, `target` or `corrections`. Log counts
   only, or add those keys, with a test.

### Tests that must exist

- **No planting.** The other person cannot put a correction in your account. This is the attack
  the recommended rule exists to stop.
- **The screen, on every end path.** A correction that fails the screen is not saved. One that
  passes is saved after the call ends, by every end path: ending, leaving, and the sweep after a
  drop.
- **No transcript text persisted.** Extend "persists no transcript and no chat anywhere"
  (`server/src/account/rooms.test.ts`) to a correction. Today it sends only chat and final
  transcripts, so it cannot see this change.
- **Deletion.** Deleting an account still erases everything, saved corrections included (the
  scans in `server/src/auth/service.test.ts`).
- **The e2e cannot cover it.** The e2e runs without an API key, so it never submits a correction.
  The server tests carry that path.

### Done when

- After each call, an account's own screened corrections are in its stored glossary, and they
  reach the next call's prompt.
- Nothing the other person typed is saved to your account.
- No download or load control remains.
- `npm run check`, the build, the secrets check, the e2e and the docker job all pass.

### Kickoff prompt

In [`HANDOFF-AGENT.md`](HANDOFF-AGENT.md#kickoff-prompts), with the owner's decisions filled in.
