# Translatv: handoff for the next agent

Written 2026-10-09 against `main` at f455585. It is for a fresh Claude Code session, or anyone,
picking up Translatv. It covers:

1. what is on `main`, and what is still open;
2. every review run so far: what each round found, what was fixed, and what is known and left,
   with a link to each round's review comment;
3. what comes next, with the owner's decisions recorded and a prompt to start each piece.

Its two siblings go deeper on their own subjects. [`HANDOFF.md`](HANDOFF.md) is the brainstorm
file: the money model, model research, product questions.
[`HANDOFF-NEXT-PRS.md`](HANDOFF-NEXT-PRS.md) is the working brief for the next two pull requests.
Nothing here is secret: the repository is public.

## Read this first

- **[`CLAUDE.md`](https://github.com/irosen419/translatv/blob/main/CLAUDE.md) is the contract.**
  This file summarizes. Where it disagrees with the code, the code wins, and say so.
- **The full record of each review is in the pull request descriptions.** Every round there
  lists the claims review proved wrong, what was fixed, and what is known and not changed. The
  commit messages carry the measurements and the mutations each fix was checked with. The
  comments linked below are each round's summary.
- **The review instruments are gone.** The loopback servers, the proxy, the mutation harnesses
  and the docker step runner lived in the session's scratch space. The commit messages describe
  each one well enough to rebuild it.
- **Line numbers drift; names do not.** Verify a fact against the code before relying on it.

## 1. Where things stand (2026-10-09)

| Item | State |
| --- | --- |
| `main` | f455585. CI (check, e2e, docker) is green on it |
| [#1](https://github.com/irosen419/translatv/pull/1): server milestones M1 to M5 | **Merged** 2026-09-28 as 3f5edff (head 5313d93), after ten rounds of review |
| [#2](https://github.com/irosen419/translatv/pull/2): per user spend (M6) | **Open, paused by the owner** since 2026-09-28 for the money model. Head 2352695. Its base is still #1's merged branch, not `main`, and it conflicts with `main` in `server/src/translate/TranslationService.ts` since #3 |
| [#3](https://github.com/irosen419/translatv/pull/3): log what a timed out translation cost | **Merged** 2026-09-30 as ba74e23 (head 01b6bff), after five rounds of review |
| The iOS contract, and corrections | **Decided** by the owner on 2026-10-09 (section 8), not started |
| The iOS app | Not started. [`PLAN.md`](PLAN.md) milestones M7 onward |
| Deploying with accounts | Not done (PLAN M29). The steps are at the end of section 3 |
| Spend | No paid API call was made in any of this work. `out/translatv/spend_log.jsonl` holds only its header row |

**Gates on `main`** (f455585, run 2026-09-30):
- `npm run check` passes:
  - dashes 0; copy 212 keys across 5 files; wire 35 fixtures; spend view clean;
  - 864 TypeScript tests (shared 66, server 506, client 270, script 22) and 29 Python tests.
- CI's `check`, `e2e` and `docker` jobs pass. The e2e is 107 checks.

## 2. How the reviews were run

Every pull request went through the `/review-loop` skill
([`.claude/skills/review-loop/SKILL.md`](https://github.com/irosen419/translatv/blob/main/.claude/skills/review-loop/SKILL.md),
on `main` since f455585):

- A reviewer subagent, in its own worktree, attacks the pull request by measuring rather than
  reading. It runs every gate, mutates source to prove each test can fail, hunts for untested
  joins, and recomputes every number the description claims.
- The main session reproduces each finding before fixing it, fixes what is real and in scope,
  re-runs every gate, pushes, and corrects the description, listing the claims that were wrong.
- The same reviewer then reviews only the delta, round after round, up to a cap.
- #1 had three reviewers per round, split by area. #2 and #3 had one each.

**What kept coming back.** Worth knowing before the next review:

1. **Descriptions claimed behavior that did not ship.** Nearly every round of #1 and #3 found
   wrong claims, and the descriptions keep the list. Measure a claim; never accept it.
2. **A fix is the least reviewed code in a pull request.**
   - #1's round 5 blocker (the delete form deleting another account) came from round 4's fix.
   - #3's round 2 blocker (TLS failures counted as spend) was round 1's fix, incomplete.
   - #3's round 3 hole (HTTP/2) was in round 2's fix.
3. **When a defect comes back one level out, change the instrument.** #3's "was this request
   ever sent?" went through four answers: a list of error codes, then a missing header note, then
   undici's connect error, then a bounded walk of the error's causes.
4. **Tests that cannot fail were the most common test defect.** Examples found:
   - a refresh floor test that compared against the constant it guards;
   - a day window test spending $0.29 against a $0.30 cap;
   - a copy test that passed with Spanish missing, because copy falls back to English;
   - a dummy hash compared by promise identity.
5. **A test that fails on correct code gets deleted, not understood.** Review removed several,
   such as a `/host/` regex that failed on a correct rewording, and `busy_timeout` pinned to
   exactly 5000.
6. **Mechanics in a cloud session:**
   - The `docker` job runs locally only with the sandbox's proxy CA mounted into its two `npm ci`
     steps. After a restart, Docker may need restarting:
     `setsid nohup dockerd >/tmp/dockerd.log 2>&1 </dev/null &`.
   - fetch refuses port 9 as a "bad port" before connecting. Use a real closed port.
   - A mutant that hangs holds its job until the job's `timeout-minutes` (10 or 15 minutes since
     #6; GitHub's default was six hours). A mutation harness must still record a hang rather
     than die on it. `script/ci_timeouts.test.mjs` fails any job without a limit of 1 to 60.
   - `pkill -f` can match your own shell. Use pid files.

## 3. #1: server milestones M1 to M5 (merged)

[#1](https://github.com/irosen419/translatv/pull/1), branch `claude/artifact-session-ao0cfe`,
merged 2026-09-28 as 3f5edff at the owner's instruction. Reviewers per round: (A) wire, storage
and infra; (B) accounts and the socket; (C) the web client and per user data.

**What it built.**
- **M1, wire export.** `ServerMessage` became zod. A generated `shared/wire/schema.json`, 35
  golden fixtures, `npm run check:wire`, and `PROTOCOL_VERSION` (2) on `/healthz`.
- **M2, Node 22.16 and SQLite.** A `node:sqlite` store with append only migrations, and a
  production boot guard that refuses a database on the image layer.
- **M3, accounts.** They replace `ADMIN_PASSWORD`:
  - invite only signup by default (`SIGNUP_MODE`, `OWNER_EMAIL`, the invite CLI);
  - scrypt passwords, 15 minute HMAC access tokens, and 30 day refresh tokens that rotate and
    revoke their whole family on reuse;
  - a lockout per account, keyed by an HMAC of the email.

  Every WebSocket upgrade needs a bearer, sent in a header or the `bearer.` subprotocol, never
  in the URL. `AUTH_SECRET` is required in production.
- **M4, the web client signs in.** Sign in, sign up, sign out and owner invites. The refresh
  token is in localStorage.
- **M5, per user data.** Preferences, a stored glossary merged into rooms, call history (a room
  code hash, never the code) and contacts derived from it. `DELETE /api/account` checks the
  password again, names the account it deletes, cascades, closes that user's sockets, and erases
  the rows from the database files.

**The rounds.**

| Round | Reviewed | Verdict | What was found and fixed | Summary |
| --- | --- | --- | --- | --- |
| 1 | 2204f03, the whole PR | BLOCK, 3 of 3 | Guesses in flight erased the login lock (e94167c). One failed COMMIT broke every later transaction until restart (87672db). The compose deploy crash looped on a root owned `./data` (10399ec, plus a CI step that boots on real volumes). Invite only signup, the owner's invite control, call history wiring and `onSignedOut` were untested (3d09c7a, 2c3ed28). The invite CLI demoted the owner (0495ec0). Node floor raised to 22.16 | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5863054473) |
| 2 | 2204f03..2c3ed28 | BLOCK, 1 of 3 | The refresh floor test compared against the constant it guards. The e2e leaked its servers (SIGTERM to npx). A loose timing test, a 500 on login for an account deleted mid check, surviving store mutants, unpinned append only migrations, and a missing CI step for bind mounts | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5863247824) |
| 3 | 2c3ed28..6590d04 | APPROVE, 3 of 3 | Pinned: the glossary body limit, the login re-read by id, the image's uid 1000, the e2e servers stopping. False positives removed. Deleting an account already deleted elsewhere signs the tab out. Secure deletion, the owner's decision (62b36f9) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5864091684) |
| 4 | 6590d04..62b36f9 | APPROVE, 3 of 3 | Secure deletion was not finished: free page space still held deleted ids. The erase now rewrites the file (VACUUM) and empties the WAL, answers "busy" at once and retries, runs last and never throws (5c1edf8) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5864461088) |
| 5 | 62b36f9..5c1edf8 | BLOCK, 1 of 3 | After another tab switched accounts, the delete form could delete the other account, a bug from round 4's fix. Now the request names its account (409 `ACCOUNT_MISMATCH`), the session never sends another account's bearer, and the form is keyed by account (d5d3261). Erase retries beside a reader grew the WAL to 839.6 MB (c5deb18) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5865141027) |
| 6 | 5c1edf8..c5deb18 | APPROVE, 3 of 3 | A refused request was replayed as whichever account the refresh landed on, and overwrote that account's preferences. Requests now go only as the account the tab showed (2da6c4f). Erase tests through the file format (aff9adb) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5869510202) |
| 7 | c5deb18..aff9adb | APPROVE, 3 of 3 | After an outage, a call could rejoin as another account. A call now keeps the account it joined as, or ends with a notice (57e37fe, c5cfb0c). `secure_delete` pinned; a hole in the regional copy guard closed | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5870463314) |
| 8 | aff9adb..c5cfb0c | APPROVE, 3 of 3 | A sign out during page restore was undone by the refresh already on the wire. Three survivors in round 7's call fix (`callTokens`). Notices became alerts. 63 of 143 regional overrides could be deleted with every gate green; each is pinned by key now (528d033, 49b2665, 8006433) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5871845459) |
| 9 | c5cfb0c..8006433 | APPROVE, 3 of 3 | Each part of the sign out fix pinned on its own; a move tracked per call, not per page; gaps in the erase's "never waits" (a writer holding the lock); the e2e reads each socket's bearer (c96c561, e361b58, 6d230a7) | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5872857756) |
| 10 | 8006433..6d230a7 | APPROVE, 3 of 3 | A refused refresh in one tab cleared the token another tab had just signed in with (a two tab test now). Notice checks accept only alerts. The Spanish "vuelve" sweep widened. ec6eedf and 5313d93 came after the last round and are tests and comments only | [comment](https://github.com/irosen419/translatv/pull/1#issuecomment-5876259214) |

At the merge: 816 TypeScript and 29 Python tests, e2e 107 of 107 (67 before review), docker 9
of 9.

**Known and not changed.** Still true on `main` unless a later pull request says otherwise.
- **Owner design calls** (questions 17 to 21 in [`HANDOFF.md`](HANDOFF.md)):
  - an open WebSocket outlives sign out;
  - the room code hash in call history is reversible (an unkeyed, truncated sha256: minutes on a
    GPU). It equals the ledger's `room` field, so a keyed hash touches the spend path;
  - a guest's stored glossary replaces the host's in the room, with no consent step;
  - the refresh token lives in localStorage (an httpOnly cookie is the stronger follow up);
  - the account API has no version. Decision A1 settles it (section 8).
- **The exported schema is lossy, and the HTTP account API has none.** The iOS contract pull
  request fixes both (section 8).
- **Tabs share one sign in.** Signing in as another account moves the other tabs at their next
  refresh, without a word, and focus lands on `<body>`. Nothing can act as the wrong account
  since rounds 5 to 7: no request, no deletion, no call.
- **Storage:**
  - two processes opening one fresh database can double apply a migration (`busy_timeout` is
    set after the journal mode);
  - the data and ledger guards let an anonymous volume or a tmpfs through, and `=0` disables
    them;
  - the erase's rewrite takes time in proportion to the file (8 ms at 1.2 MB, about 0.7 s at
    100 MB), so at size it belongs in a quiet hours job;
  - a tool that holds a read open for good (Litestream, say) keeps every erase retrying for its
    hour and then giving up: rows stay zeroed, older copies stay in the WAL;
  - with a read only root filesystem, the rewrite fails above a few MB;
  - a restart forgets pending erase retries.
- **Accessibility and copy:**
  - `<html lang>` stays "en" in Spanish (predates #1);
  - the pre-join screen's notice has no role, so a refused microphone is not announced there
    (predates #1);
  - a tab whose account was deleted elsewhere lands on sign in without saying why;
  - a new base Spanish line in the tú form with no regional override is caught only by the word
    sweeps.
- **Tests:** smaller untested branches (the preferences rollback, "same account on both ends is
  not a contact", `consumeInvite` expiry, `setCallPeer` overwrite); two sub second waits in the
  erase that only timing could see; a test lock that stores nothing while it holds.
- **GitGuardian's hits on the wire fixtures are synthetic.** #1's description explains each one.

**Deploying (PLAN M29, not done).** From #1's description:
1. Set `AUTH_SECRET` (32 or more characters), `OWNER_EMAIL` and `SIGNUP_MODE`.
2. Make sure uid 1000 can write the two directories compose mounts, `./out` and `./data`
   (`sudo chown -R 1000:1000 out data` unless a uid 1000 account made the clone).
3. After the server has started once, mint the first invite with
   `docker compose exec app node server/dist/cli/invite.js`. Run as root before the first boot,
   the host's `npm run invite` creates a database the server cannot write.

## 4. #2: per user spend, M6 (open, paused)

[#2](https://github.com/irosen419/translatv/pull/2), branch
`claude/artifact-session-ao0cfe-spend`, stacked on #1's branch. It is a spend change, so it is
held for the owner whatever a review says.

**What it does.** Ledger rows gain `user_id`, the opaque id of the room's host, who pays for the
call. There is a per user daily cap, `USER_DAILY_CAP_USD` (default 1.0), beside the global and
room caps, with a `USER_CAP` refusal and its copy. `spend_log.py` reports totals per user.

**Paused 2026-09-28.** The owner changed the money model: each user pays for their own
translation, with no default cap and an optional cap the user sets. That replaces this pull
request's core, so its review stopped after round 2.

| Round | Reviewed | Verdict | What was found and fixed | Summary |
| --- | --- | --- | --- | --- |
| 1 | 2204f03...47c5bd2, its own diff | BLOCK | A ledger row with `user_id: "constructor"` crashed the live server, because the buckets were a plain object; both maps in `totals()` now have a null prototype (9bc09d3). A day window test that could not fail (5b213f1). A copy test that passed with Spanish missing (3f356b8) | [comment](https://github.com/irosen419/translatv/pull/2#issuecomment-5863055563) |
| 2 | 47c5bd2..997db8b | APPROVE | Smaller: tests tied to CONFIG values, three mutants no test caught, and a Python reader crash on a non string `program`. Fixed in d2dbcf0 and e0be86d, **which no reviewer has seen** | [comment](https://github.com/irosen419/translatv/pull/2#issuecomment-5863248976) |
| Paused | | | The state of the head, and what should survive | [comment](https://github.com/irosen419/translatv/pull/2#issuecomment-5863796847) |

**When it is reshaped** (after the money model brainstorm, not before):
- **Keep:** attribution of spend to an account, the readers' null prototype maps and per account
  rounding, and the Python crash fix (d2dbcf0).
- **Replace:** "the host pays", and the $1 default cap.
- **Retarget to `main` and merge `main` in.** It conflicts in
  `server/src/translate/TranslationService.ts` with #3.
- **Exclude `billable: false` rows** from anything charged to a user. #3 writes them for late
  answers, and this is where "never charge a user" gets enforced.
- **Put a retriable `translation.failed` fixture back.** #2 rewrote the only one into
  `USER_CAP`.
- **Known from its review:** concurrent calls can overshoot the per user cap (8 at once booked
  4.64 times a $0.001 test cap, about half a cent against $1); a refused host on a phone sees
  only "sin traducir"; nothing tests the cap's wiring in `index.ts`; `RoomManager.create`
  defaults `userId` to `""`.

## 5. #3: the timeout ledger (merged)

[#3](https://github.com/irosen419/translatv/pull/3), branch `claude/timeout-ledger`, merged
2026-09-30 as ba74e23 at the owner's go ahead. One reviewer, five rounds.

**What it does.** The owner's decision of 2026-09-28: log a timed out request's cost, and eat
it.
- A call the room gave up on (6 s) runs on, and its real cost is logged with `billable: false`.
- A request that was sent and lost its answer is logged with `cost_usd: null` and
  `worst_case_usd`, and the caps count the worst case.
- A request that never left the machine writes nothing. That is read from undici's
  `undici:client:connectError` diagnostics channel, walking up to four causes of the error.
- The adapter makes the one retry itself, following the SDK's rules, and never after the room
  was told TIMED_OUT.
- A call with no answer after 60 s is aborted and logged as lost. At shutdown, every call in
  flight is logged once, at its worst case.

| Round | Reviewed | Verdict | What was found and fixed | Summary |
| --- | --- | --- | --- | --- |
| 1 | eee9955 | BLOCK | An outage looked like spending: refused or unresolved connections were logged at their worst case, and 182 lines filled a room's cap with nothing sent. The SDK's retry sent paid requests after TIMED_OUT. The worst case, the daily cap and the billable marker had no test that could fail (4f8ebbb) | [comment](https://github.com/irosen419/translatv/pull/3#issuecomment-5878558530) |
| 2 | 4f8ebbb | BLOCK | A failed TLS handshake counted as sent (183 lines, the room locked out), and no list of error codes could fix it, so undici's record replaced the list. A stalled event loop sent a retry after the deadline. Nothing tested that a lost row is written before its retry (0cd036d) | [comment](https://github.com/irosen419/translatv/pull/3#issuecomment-5879903494) |
| 3 | 0cd036d | APPROVE | A latent HTTP/2 hole: round 2's signal exists only over HTTP/1. "Never sent" now rests on positive evidence, the connect error (37fb51b) | [comment](https://github.com/irosen419/translatv/pull/3#issuecomment-5880649077) |
| 4 | 37fb51b | APPROVE | A proxy's refusal (407) sat two causes down, and counted as sent. The adapter now walks the causes, bounded (b1dfa8a) | [comment](https://github.com/irosen419/translatv/pull/3#issuecomment-5881404980) |
| 5 | b1dfa8a | APPROVE | Nothing blocking. After the last round, d4e5f5c pinned that only a published connect error counts as never sent: a shortcut trusting fetch's wrapper had passed every test | [comment](https://github.com/irosen419/translatv/pull/3#issuecomment-5881761286) |

Mutations by the end: 58 run, 54 red. The four green are disclosed in the description: two are
equivalent, one is untested wiring (`index.ts` shutdown), and one is connect errors kept in a
plain Set.

**Known and not changed.**
- **A late call keeps its concurrency slot until it settles** (question 23, the owner's call).
  It bounds the unknown spend a hung provider can run up, at a cost in throughput: with 1 call
  in 7 hanging, 90 of 600 calls were refused in review's simulation.
- **The worst case grows with the glossary**, which the room's people control: about $0.03 a
  request with a full glossary in ASCII, about $0.09 in three byte text.
- **A middlebox that accepts connections and closes them unread** gets each request counted,
  because it was written. Done to every connection, that fills the caps.
- **An answer for a room that ended mid flight stays chargeable.**
- **A crash loses the rows of calls in flight** (at most 8), and the ledger trails in flight
  spend by up to 8 calls.
- **Totals report no upper bound.** Only the gate uses the worst case.
- **"Never sent" rests on undici's connect error channel.** If Node stopped publishing it, every
  failure would count as sent: safe for the ledger, but round 1's lockout. The loopback tests
  would go red.
- **A retry started just before the deadline is paid for and wasted.** Avoiding it needs
  latency data the repository does not have.
- **Smaller:** fetch's bad port refusal counts as sent (unreachable in production); an abort at
  shutdown counts a request still connecting as lost; the certificate case is measured only with
  an instrument (it needs a key pair, which this public repository will not carry); an unpriced
  model's null worst case has no test; the e2e runs with no API key, so it never reaches this
  code.
- **`npm run verify` printed "Reason: undefined"** when its first call failed. Fixed by #5
  (section 8.3).

## 6. Commits made straight to `main`, at the owner's request

- **a8d1828** (2026-09-29): [`docs/HANDOFF.md`](HANDOFF.md), the brainstorm file for voice
  sessions.
- **f455585** (2026-09-30): the `/review-loop` skill, brought in line with `main`'s CLAUDE.md,
  and both handoff files updated for #3's merge.

## 7. Decisions on record

[`HANDOFF.md`](HANDOFF.md) section 4 has them in the owner's words. The ones that shape the next
work:
- **2026-09-28:** each user pays for their own translation, with no default cap and an optional
  one they set (this paused #2).
- **2026-09-28:** a timed out request is logged, and the business eats its cost (#3).
- **2026-09-28:** nobody downloads transcripts anymore; corrections are saved to the account,
  with a filter for malicious ones.
- **2026-09-28:** deleted accounts are fully erased (done in #1).
- **2026-09-28:** the iOS contract is the next pull request, on a new branch.
- **2026-09-30:** merge #3; put the review skill on `main`.
- **2026-10-09:** **"All recommended"**, for A1, A2 and C1 to C6. Section 8 spells each out.

## 8. Next steps

In order. The first two are independent and can run at the same time.

### 8.1 The iOS contract pull request

Make the exported schema say what the zod schemas enforce, give the HTTP account API exported
schemas, fixtures and a version, and test that the server really sends those shapes. It
unblocks the iOS milestones M7 and M9. The full brief is Part A of
[`HANDOFF-NEXT-PRS.md`](HANDOFF-NEXT-PRS.md).

**Decided 2026-10-09:**
- **A1. The account API's version.** An `API_VERSION` constant in `shared/`, with the same bump
  rule as `PROTOCOL_VERSION`. `/healthz` serves it beside the socket's version, and the exported
  schema carries it. No path changes: the web client ships with the server, and the app reads
  `/healthz` when it starts.
- **A2. Ajv.** Yes, as a dev dependency only, for the test that compiles the schemas in strict
  mode.

**Mind the shared snag.** The server already sends glossary entries whose `source` is a whole
utterance (up to 2000 characters), past the 200 the schema allows from clients. Until the
corrections pull request lands, do not publish a 200 character limit on what the server sends:
publish what it really sends, or give the client and server shapes separate schemas.

### 8.2 The corrections pull request

Save each person's own corrections to their account after each call, screened by rules, and
remove the transcript download and "Load corrections from a past chat". The full brief is Part B
of [`HANDOFF-NEXT-PRS.md`](HANDOFF-NEXT-PRS.md).

**Decided 2026-10-09:**
- **C1. A saved correction is a term, not a sentence.** The fix dialog asks for the phrase and
  its fix, up to 200 and 400 characters, prefilled from the line. Each saved entry is a real
  glossary term, reusable in the next call. This keeps transcript text out of storage, fits the
  stored glossary, and ends the prompt size problem (40 whole sentences could add about 96,000
  characters to every request).
- **C2. An account keeps only its owner's corrections.** The server records the author in
  `handleCorrect` (the connection already knows its account). The other person's corrections
  still apply during the call and never reach your account. The fix button shows only on the
  other person's lines, the translations you actually read.
- **C3. They are saved to the stored glossary** from #1, which already loads into every call. At
  its 40 entry limit, the newest wins, as in a room.
- **C4. They are saved after each call,** from `closeCall`, before the session is deleted. Not
  nightly.
- **C5. They are screened by rules only, which cost nothing:**
  - drop an empty, identical or over length pair;
  - drop control and formatting characters;
  - drop text that reads as instructions to the model rather than a term (a second lock: the
    prompt already fences corrections off as data);
  - require the pair's dialects to match the direction it was read in.

  Rules cannot catch a flipped meaning ("sí" saved as "no"), so the backstop is a list of each
  person's saved entries, with a delete. That list is part of this pull request; where it lives
  in the app is the implementer's call, and the pull request should say. No model call, so
  nothing spends.
- **C6. `glossary.import` stays in the protocol.** The web client stops sending it once loading
  goes. Removing it would be a wire change, and the server merges stored glossaries through the
  same path.

**Also in scope, from the brief:** `FORBIDDEN_KEYS` in `server/src/log.ts` does not cover
`source`, `target` or `corrections`; log counts only, or add those keys, with a test. Every new
or reworded copy key goes into `en.json` and `es.json`, with regional overrides only where they
differ. Render the changed UI in Spanish at 390 pixels, since Spanish runs about 25 percent
longer, and check that no text truncates and no diacritic clips. Phones have no correction UI
today (the panel renders only from 860 pixels); the pull request should say whether it adds one.

### 8.3 Small fixes

- **Done in #5:** `npm run verify` printed "Reason: undefined" when its first call failed, because
  a failed translation carries `reason`, not `message`. Every failure it prints now goes through
  `describeFailure` (`script/translate_failure.mjs`): the code, the status, and whether a retry
  can help. Still open: no test runs the script, so its wiring is unguarded (deleting the import
  stays green). Seeing it needs a loopback stub run, which first needs the script's ledger root
  made configurable.

### 8.4 Waiting on the owner

Not for an agent to start alone.
- **Pick a translation model before Haiku 4.5 retires.** It retires no sooner than
  2026-10-15, with 60 days' notice, and there is no newer Haiku. The blind test in
  [`HANDOFF.md`](HANDOFF.md) section 6 decides it, costs about $6 in API calls (each logged
  first), and needs the owner's go ahead. Questions 10 to 12.
- **The money model brainstorm** (questions 1 to 9), then reshape #2 (section 4).
- **A late call's slot** (question 23), the design calls left by #1 (questions 17 to 20), launch
  platforms, people without accounts, and open signup (questions 13, 15 and 16).
- **Deploy the server with accounts** (section 3's steps), and mint the first invites.
- **Measure finished sentences per call-minute on real calls.** It narrows every cost range in
  [`HANDOFF.md`](HANDOFF.md) about threefold.

### 8.5 The iOS app

[`PLAN.md`](PLAN.md) stage 2: milestones M7 to M19 run in a cloud session, after the iOS
contract lands (M7 and M9 build on it). Then device work on the owner's Mac and phone, M20 to
M28: signing, permissions, echo, dialect recognition, TURN for cellular calls, battery, and
real translation quality.

### Kickoff prompts

Each starts a fresh Claude Code session from `main`.

```text
Build the iOS contract pull request for github.com/irosen419/translatv.

Read CLAUDE.md, then docs/HANDOFF-AGENT.md, then docs/HANDOFF-NEXT-PRS.md (Part A and "The
shared snag"), then D7 in docs/PLAN.md. Work on a new branch cut from main, named
claude/ios-contract.

Owner decisions (2026-10-09):
A1 = an API_VERSION constant in shared/, with PROTOCOL_VERSION's bump rule, served by /healthz
     beside the socket's version and carried in the exported schema. No path change.
A2 = yes, Ajv as a dev dependency only.

Verify each fact in the handoff against the code before relying on it, and say where it was
wrong. Follow TDD. Run every gate the handoff lists. Open a pull request and never merge it.
Run the /review-loop skill on the pull request. Report what you built, what the review found,
and what is left for the owner.
```

```text
Build the corrections pull request for github.com/irosen419/translatv.

Read CLAUDE.md, then docs/HANDOFF-AGENT.md, then docs/HANDOFF-NEXT-PRS.md (Part B and "The
shared snag"), then section 8 of docs/HANDOFF.md. Work on a new branch cut from main, named
claude/corrections.

Owner decisions (2026-10-09):
C1 = term level corrections: the dialog asks for the phrase and its fix (up to 200 and 400
     characters), prefilled from the line.
C2 = an account keeps only its owner's corrections, with the author recorded on the server; the
     fix button shows only on the other person's lines.
C3 = the stored glossary; at 40 entries the newest wins.
C4 = after each call, from closeCall, before the session is deleted.
C5 = rules only, no model call; each person sees their saved entries, with a delete.
C6 = keep glossary.import in the protocol.

Verify each fact in the handoff against the code before relying on it, and say where it was
wrong. Follow TDD. Run every gate the handoff lists. Open a pull request and never merge it.
Run the /review-loop skill on the pull request. Report what you built, what the review found,
and what is left for the owner.
```

## 9. Rules that bit during review

All are in [`CLAUDE.md`](https://github.com/irosen419/translatv/blob/main/CLAUDE.md); these are
the ones the reviews kept checking.
- No em or en dashes anywhere: code, comments, strings, prompts and docs (`npm run check:dashes`,
  which reads only tracked files: stage a new file before running it).
- No spend without its ledger row first. A pull request that spends, or touches
  `out/translatv/spend_log.jsonl`, `spend_log.py`, `server/src/spend/` or `pricing.ts`, waits for
  the owner whatever a review says.
- The logger takes counts, identifiers and durations only. Transcripts, chat and room glossaries
  are never persisted. Migrations are append only.
- No secret behind a `VITE_` prefix (`npm run check:secrets` reads the built client).
- Agent work goes on its own branch cut from `main`. Never force push; a push that would need
  force is a stop to report. Merge the base in, never rebase someone else's branch.
- The owner merges, with an ordinary merge commit.

## 10. Where else to look

- **The pull request descriptions:** [#1](https://github.com/irosen419/translatv/pull/1),
  [#2](https://github.com/irosen419/translatv/pull/2), [#3](https://github.com/irosen419/translatv/pull/3).
  Each round's claims proven wrong, fixes, and what is known and left.
- **The commit messages** on each pull request's branch: the measurements, and the mutations each
  fix was checked with.
- [`HANDOFF.md`](HANDOFF.md): the money math, the model research, the open questions.
- [`HANDOFF-NEXT-PRS.md`](HANDOFF-NEXT-PRS.md): what exists, what to build, and when each of the
  next two pull requests is done.
- [`PLAN.md`](PLAN.md): the plan of record for the server and the iOS app.
- `README.md`, `DEPLOY.md`, `TESTING.md`: running, deploying and testing it.
