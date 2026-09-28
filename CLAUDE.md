# Translatv conventions

Translatv: realtime translated video calls, on the web and (in progress) on iOS. Two person rooms,
WebRTC peer to peer media, live translated subtitles. English and Spanish, with regional dialect
support (Argentine voseo, Mexican and Peninsular Spanish, and so on). This file is the working
contract for any agent editing this repo.

Translatv began as a copy of the private video-translation project (2026-09-27) and is now its own
project, with its own server, its own spend ledger and its own history. `docs/PLAN.md` is the
plan of record for the multi-user server and the iOS app.

## House rules

- Keep CHAT replies short. Lead with the answer or the action, skip the reasoning unless asked,
  and do not re-summarize work already described. Commit messages, PR descriptions and code
  comments stay as long as they need to be: this repo's style depends on them carrying the why,
  and the reader of a commit went looking for it. A reader in chat did not. The two are different
  audiences and the length rule only applies to one.
- NO em dashes or en dashes anywhere, including comments, strings, prompts, and docs. Use commas,
  periods, colons, or parentheses only. Enforced by `npm run check:dashes`, which must report zero.
- Never spend against the Anthropic API without the spend going through the ledger first. Every call
  that costs money appends to `out/translatv/spend_log.jsonl` before the next one is issued.
  Untracked spend is the specific failure this repo was set up to avoid.
- There is no autopilot in this repo yet. If one is added, arming a step that spends is owner only,
  always, and no automation ever flips an `"armed"` flag.
- Never log transcript text, chat text, usernames, or glossary content, and never emails,
  passwords, access or refresh tokens, or invite codes. The logger takes counts, identifiers
  (an opaque user id, never an email), and durations only. Unit tests assert it drops a `text`
  field and an `email` field.
- Never put a secret behind a `VITE_` prefix. Vite inlines every `VITE_*` variable into the client
  bundle, so a `VITE_ANTHROPIC_API_KEY` would ship the key to every visitor. `npm run check:secrets`
  greps the built client for key prefixes and fails on a hit.
- TDD for code changes: red, green, refactor.

## Stack and layout

- Node 22.16+ (22 LTS; the store uses the built in `node:sqlite`, and 22.16 is the first 22
  release with `DatabaseSync#isTransaction`) and npm workspaces: `shared` (wire protocol),
  `server` (Express plus ws), `client` (React 18 plus Vite). TypeScript strict everywhere.
- `shared/src/protocol.ts` is the SINGLE source of truth for the WebSocket wire format. Both sides
  derive their types from its zod schemas, and those same schemas are the server's input validation
  layer. Never hand-write a duplicate type for a message.
- Media is WebRTC peer to peer. The server relays signaling and text, and never sees audio or video.
- Each browser transcribes its OWN microphone and sends text. Nobody transcribes the remote stream.
- Speech to text sits behind the `SttAdapter` interface in `client/src/stt/types.ts`. The Web Speech implementation is the
  default; a paid engine is a config change, not a rewrite.
- Room state is in memory only, and a server restart legitimately destroys every room.
- Durable state (accounts and tokens from M3) lives in SQLite through Node's built in
  `node:sqlite`, under `server/src/store/`, in `DATA_DIR/translatv.db`. No native npm dependency.
  Migrations in `server/src/store/migrations.ts` are APPEND ONLY. Tests use `":memory:"`. In
  production the data directory must be a mounted volume: the server refuses to start on the
  image layer unless `ALLOW_EPHEMERAL_DATA=1`.
- Accounts (M3) live in `server/src/auth/`: scrypt passwords, 15 minute HMAC access tokens keyed
  from `AUTH_SECRET` (production refuses to start without it), 30 day refresh tokens stored hashed
  and rotated on every use, with reuse revoking the whole family. Every WebSocket upgrade needs a
  valid access token (`Authorization: Bearer` for native clients, the `bearer.<token>` subprotocol
  for browsers, never the URL); a browser's Origin must still match the allowlist. The HTTP account
  API's schemas and error codes are in `shared/src/auth.ts`. `ADMIN_PASSWORD` is retired.
- Per user data (M5) lives in `server/src/account/`, with its HTTP schemas in
  `shared/src/account.ts`: dialect preferences, a stored glossary (merged into a room through the
  same path as `glossary.import`), and call history (a room code HASH, never the code). Contacts
  are derived from call history, never stored. Transcripts, chat and room glossaries are NEVER
  persisted. `DELETE /api/account` re authenticates, deletes the user row and lets ON DELETE do
  the rest (CASCADE for what the user owns, SET NULL for what only mentions them, such as a
  peer's call history), then closes that user's live sockets. It never touches the spend ledger.

## Spend tracking

- `out/translatv/spend_log.jsonl` is the append only source of truth, one JSON object per
  API call. `spend_log.md` beside it is a GENERATED VIEW and is never parsed or hand edited.
- Two implementations read the same file: `server/src/spend/ledger.ts` (the live writer, because
  spend happens in process during calls) and `spend_log.py` (a standard library only CLI, so Python
  tooling works against this repo unchanged). A shared fixture asserts they agree.
- Honesty rules, each carried over from awws because each one was a bug that shipped:
  - A missing ledger RAISES. It is not an empty list. "No ledger" and "spent nothing" are different
    facts, and a budget gate that confuses them buys exactly the calls the cap existed to prevent.
    A caller that genuinely tolerates absence opts in with `missingOk`.
  - An unrecoverable cost is null, NEVER zero. A zero silently understates the total.
  - Totals report `known_usd` alongside `unparsed_rows`, so a partial total is presented as a floor
    rather than as a precise figure quietly missing rows.
  - A stated cost that contradicts its own token counts and unit prices is refused at write time,
    not stored. The harmful direction is under-logging.
  - Only prices documented in this repo appear in `pricing.ts`, each with a source comment. An
    unpriced model yields null, which renders as "cost unknown". Never interpolate a price.
- Rows carry `user_id` (M6, D10): the opaque account id of the room's HOST, who pays whoever
  spoke. Never an email or a name. Rows from before the field have no key, and an absent key and
  a null both mean "unattributed", which totals as its own bucket and is never an error. A paid
  call in a room needs the global daily cap, the room cap AND the per user daily cap
  (`USER_DAILY_CAP_USD`) to pass, so the per user cap can only tighten the other two. Spend that
  belongs to no account (verification) has no user to cap and is bound by the other two.
- Money is rounded to 6 decimals everywhere, matching the dashboard's Ruby reader and awws's
  `spend_log.py`, so a figure on the cockpit and one from the CLI cannot differ in the tail.

## The dashboard

- The owner's project dashboard derives its project list from brain cards at
  `~/second-brain/projects/*.md`, NOT from anything in this repo. A card at
  `~/second-brain/projects/translatv.md` is required before this project appears on the board, and
  its tags must not include `books`. The dashboard reads this repo's ledger by the slug `translatv`.

## Tests

- `npm test` runs the TypeScript suites (vitest).
- `python3 -m unittest discover -s . -p 'test_*.py'` runs the Python suites. Standard library only:
  no pytest, no third party imports, and no test touches the network.
- `npm run check` runs the dash grep, typecheck, and both suites together.

## Git

- PUBLIC repo github.com/irosen419/translatv, default branch main. Public because the iOS app
  builds on GitHub hosted macOS runners, which are free for public repositories. Being public is
  also why no secret may ever be committed: secrets live in environment settings only. Commit and push are
  owner gated unless asked. No force pushes.
- Agent work goes on its OWN branch cut from whatever branch is checked out, never straight onto a
  branch the owner's machine is also committing to. The owner merges that base first, then the
  feature branch rebases onto main if it needs to. This exists because both the owner's machine and
  the agent push, and a non fast forward once moved the branch backwards over a CI fix and an entire
  redesign (owner decision, 2026-07-31).
- `git pull --rebase` before committing, and treat a push that would need force as a STOP signal to
  report, not an obstacle to get past.
- On a `out/translatv/spend_log.jsonl` merge conflict, KEEP BOTH SIDES. Never drop a ledger
  row to resolve a conflict: the file is append only and untracked spend is the failure this repo
  exists to prevent.

## Merging

The `review-and-merge-prs` skill (`.claude/skills/`) reviews the open pull requests and merges the
ones its review approves. These are the translatv rules it defers to when it consults this
file. They ADD to the skill's own guardrails and override its defaults where they disagree.

- Spend gate on merging: never auto-merge any pull request that SPENT MONEY or that touches
  `out/translatv/spend_log.jsonl`, `spend_log.py`, `server/src/spend/`, or `pricing.ts`.
  Hold them all for the owner regardless of the
  review verdict, so a human reconciles the pull request's stated spend against the ledger and the
  resolved budget before it lands. A green suite is necessary but never sufficient to merge spend.
  This mirrors the asset gate in awws, and for the same reason: the machine check does not get the
  final say on money.
- Automatic HOLD, never a merge, on any pull request that REMOVES rows from
  `out/translatv/spend_log.jsonl`. The ledger is append only, and a deletion is either a
  botched conflict resolution or lost spend. Both need a human.
- Never merge on a red or still pending required check. `npm run check` (dash grep, copy parity,
  typecheck, both suites) is the bar.
- Merge with an ordinary merge commit, matching the owner's other repositories. Do not switch to
  squash or rebase without asking.
