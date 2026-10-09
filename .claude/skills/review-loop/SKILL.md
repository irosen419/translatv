---
name: review-loop
description: "Adversarial, multi round review of one pull request, several, or every open one. A worktree isolated reviewer subagent attacks the PR by measuring rather than reading: it runs every gate, mutates source to prove each test bites, hunts untested joins, and recomputes every number the description claims. The main session verifies each finding itself, fixes what is real and in scope, re-runs every gate, pushes, corrects the PR description, and sends the delta back for another round, up to a round cap. It merges only when approved, CI is green on the exact head, there is no conflict, and every merge gate in CLAUDE.md passes. Use when the user says /review-loop, or explicitly asks for an adversarial or multi round review loop on a PR or on all open PRs. For a single pass review with no fixing use /code-review; to sweep and merge many PRs on one pass verdicts use /review-and-merge-prs."
argument-hint: "<PR number(s) | all> [max rounds, default 5]"
---

# Adversarial review loop

A reusable prompt pair for reviewing a pull request hard enough that the review finds real
defects rather than agreeing with the description.

Invoked as `/review-loop <target> [max rounds]`. Arguments for this run: `$ARGUMENTS`

- `<target>` is one PR number, several (`12 14`), or `all` for every open PR. With no target,
  ask which PR rather than guessing.
- `[max rounds]` caps the rounds per PR. Default 5.

Part 1 is your instruction as the main session. Part 2 is what you give the reviewer. Part 3 is
what you send back for each follow up round. Parts 2 and 3 are mostly boilerplate: fill every
`{{placeholder}}` before sending anything, from the PR itself and from "Filling the placeholders
in this repo" below. Never send a reviewer a brief with a placeholder still in it.

---

## Part 1: the main session's instructions

> Run an adversarial review loop on PR **{{PR_NUMBER}}** in **{{OWNER/REPO}}**, up to
> **{{MAX_ROUNDS, default 5}}** rounds or until approved with CI green on the head you actually
> merge.
>
> Spawn the reviewer as a worktree isolated background subagent so it cannot disturb my tree.
> Give it the brief in Part 2 below, filled in for this PR. Then, for each round:
>
> 1. **Verify every finding yourself before acting on it.** Reproduce the failure. If the finding
>    is "this test does not bite", apply the mutation and watch the suite. Do not fix on the
>    reviewer's say so, and do not dismiss on your own say so either.
> 2. Fix what is real, strictly in scope. Repo conventions win over the reviewer's preferences.
> 3. Re-run the full gates, including any the repo's default check command leaves out.
> 4. Push, then correct the PR description wherever the review proved it wrong. List the wrong
>    claims rather than quietly editing them out.
> 5. Send the delta back for another round with Part 3. Do not self certify your own fixes.
>
> Merge only when: approved, CI green **on the exact head being merged**, no merge conflict, and
> {{ANY PROJECT SPECIFIC GATES}}. If a gate blocks, say so and stop rather than merging.
>
> Report to me at the end of each round: what was found, what I should know, what you changed.
> Keep it short. Lead with whether it is blocked.

---

## Part 2: the reviewer's brief

> Adversarially review PR **{{PR_NUMBER}}** in **{{OWNER/REPO}}**, branch `{{BRANCH}}`, head
> `{{HEAD_SHA}}`, base `{{BASE}}` at `{{BASE_SHA}}`.
>
> Read **{{CONVENTIONS_FILE}}** first. It is the contract. Then read the PR description.
>
> **Your job is to find what is wrong, and to verify every claim the description makes rather
> than accepting it.** Confident descriptions of behavior that did not ship are the most common
> defect in this repo's pull requests. Assume the same is true here until you have measured
> otherwise.
>
> **Measure, do not read.** Where you can run it, run it. Where you can render it in a browser,
> render it. Where you can mutate the source and watch a test go red, do that. Say explicitly, per
> finding, what you measured versus what you reasoned about.
>
> ### Run the gates yourself
>
> - `{{CHECK_COMMAND}}`
> - `{{ANY GATE NOT INCLUDED IN THE ABOVE}}` (name them, and note that a gate outside the default
>   check command is exactly how a red one reaches merge)
> - Report the real numbers, not the description's.
>
> ### Point hardest at the tests
>
> A large test diff is the biggest risk in any PR, because a test that cannot fail is worse than
> no test: it buys confidence and pays nothing. For each load bearing assertion:
>
> - **Mutate the source, not the test, and confirm the test fails.** If it stays green, the guard
>   is decorative. Report it as blocking.
> - **Also confirm it does not fail on CORRECT code.** Try the refactors a competent person would
>   plausibly do next: extract a component, rename a symbol, reorder arguments, add a property,
>   reformat. A guard that reddens on a legitimate change gets deleted rather than understood, so
>   a false positive is a finding, not a nitpick.
> - Look for assertions that pass vacuously: iterating an empty list, a regex that matches
>   nothing, comparing a derived value to itself, a filename or string the code no longer uses.
>
> ### Hunt for the untested join
>
> The recurring defect shape is: function A is tested, consumer B is tested, and **nothing tests
> that B calls A**. Walk each chain in the diff end to end and name every link. For each link ask
> whether a mutation there would be caught. Report every one that would not be, even when the
> shipped code is correct.
>
> If the test suite is structurally blind to a class of fact (a headless suite cannot see
> rendering; a unit suite cannot see wiring; a mocked suite cannot see the real protocol), say so
> plainly and name the instrument that would see it, rather than proposing another guard of the
> same kind.
>
> ### Verify the numbers
>
> Any figure in the description (benchmarks, contrast ratios, sizes, percentages, token counts)
> must reproduce independently. Recompute from the source data. If you get a different answer,
> say so and show your method. If a figure has no unit or no stated method, that is a finding.
>
> ### Other things worth a pass
>
> - Anything the description does **not** mention but the diff does. Undisclosed changes.
> - Whether this PR silently amends a decision from a recent merged PR.
> - Security adjacent files touched by a change that has no business touching them.
> - {{DOMAIN SPECIFIC ASKS}}
> - {{HARD PROJECT RULES from the conventions file, restated as things to check}}
>
> ### Report
>
> 1. **BLOCK or APPROVE** up top.
> 2. Blocking issues, each with `file:line` and a concrete failure scenario.
> 3. Non blocking findings.
> 4. **Every claim you could NOT verify, and why.** This section is mandatory and is often the
>    most useful part.
>
> Do not fix anything. Report only.

---

## Part 3: the follow up round

> Round **{{N}}** on PR {{PR_NUMBER}}. Head is now `{{NEW_HEAD}}`. Review **only** what changed
> since `{{PREVIOUS_HEAD}}`; you have already cleared the rest.
>
> Standing instruction: verify independently. **Do not treat my account of what I did as evidence
> that I did it.**
>
> I reproduced your findings myself before acting. [Say which, and what you saw.]
>
> What changed: [list each fix, and for each, the specific thing you want attacked about it.]
>
> Mutations I ran, baseline {{N}} tests: [list, with red/green for each.] Please re-run these
> yourself, and **hunt for one more that should be caught and is not.**
>
> Gates on this head: [real numbers.]
>
> Verdict on the delta only: BLOCK or APPROVE.

---

## Filling the placeholders in this repo

| Placeholder | Value in translatv |
|---|---|
| `{{OWNER/REPO}}` | `irosen419/translatv`. Confirm with `git remote get-url origin`. |
| `{{PR_NUMBER}}`, `{{BRANCH}}`, `{{HEAD_SHA}}`, `{{BASE}}`, `{{BASE_SHA}}` | From the PR itself. Always pin SHAs, never a branch name alone, so the reviewer reviews the head you named. |
| `{{MAX_ROUNDS}}` | The second argument, else 5. |
| `{{CONVENTIONS_FILE}}` | `CLAUDE.md` as it stands at the PR head (a PR can amend it: review against the head's copy and flag the amendment). Add `docs/PLAN.md` when the PR implements a milestone from it. |
| `{{CHECK_COMMAND}}` | `npm ci && npm run check`, which is the dash grep, copy parity, the wire fixtures, the spend view, typecheck, and both test suites. Read the `check` script at the PR head, because a PR can add to it. |
| `{{ANY GATE NOT INCLUDED IN THE ABOVE}}` | `npm run build`; then `npm run check:secrets` (it greps the BUILT client, so it needs the build); `npm run e2e` (two real browsers; it binds port 0, so parallel runs do not collide); and the CI `docker` job (image build, `/healthz`, the ledger append check, and every production boot refusal step, each run as `.github/workflows/ci.yml` runs it). Read `ci.yml` at the PR head for the current list. |
| `{{ANY PROJECT SPECIFIC GATES}}` | The translatv merge gates below. |
| `{{DOMAIN SPECIFIC ASKS}}` | The list below. |
| `{{HARD PROJECT RULES}}` | The list below. |

**Domain specific asks.**

- i18n completeness: every copy key present in `en.json` and `es.json`, and in the regional files
  where they override. Spanish runs about 25 percent longer than English, so render the changed UI
  in Spanish at phone width (390px) and look for truncation, overflow, and bad wrapping, and check
  that diacritics (á é í ó ú ñ ¿ ¡) are not clipped by line height or overflow. Render it; do not
  infer it from CSS.
- Accessibility: labels on inputs, focus order, errors that are announced, contrast.
- Security: auth, tokens (never in a URL), sockets, Origin checks, rate limits, and anything
  that widens the server's boundary. Media is peer to peer and the server never sees audio or
  video, so a change that routes media or a remote stream's transcription through the server is
  a finding.
- Concurrency and error paths: two person rooms, reconnect and resume, a peer dropping mid call,
  and a server restart legitimately destroying every room.
- The wire protocol: `shared/src/protocol.ts` is the single source of truth, and its zod schemas
  are the server's input validation. A hand written duplicate type for a message is a finding.

**Hard project rules, restated as checks.**

- Zero em or en dashes anywhere (`npm run check:dashes` must report zero).
- No spend without its ledger row written first. Untracked spend is the failure this repo exists
  to prevent.
- The logger never receives transcript text, chat text, usernames, glossary content, emails,
  passwords, access or refresh tokens, or invite codes.
- Transcripts, chat and room glossaries are never persisted.
- Migrations in `server/src/store/migrations.ts` are append only.
- No secret behind a `VITE_` prefix.
- Each browser transcribes only its own microphone.
- Spend honesty: a missing ledger raises unless the caller opts into `missingOk`; an
  unrecoverable cost is null, never zero; totals carry `known_usd` beside `unparsed_rows`; a cost
  that contradicts its own tokens and prices is refused at write time; only documented prices,
  each with a source comment, appear in `pricing.ts`; money is rounded to 6 decimals.
- The repo is public, so nothing secret may be committed. A high entropy string in a fixture has
  to be provably synthetic.
- TDD: a behavior change arrives with a test that fails without it.

**Merge gates.** These add to Part 1 and win wherever they disagree with it.

- HOLD, never merge, any PR that spent money or touches `out/translatv/spend_log.jsonl`,
  `spend_log.py`, `server/src/spend/`, or `pricing.ts`, whatever the verdict. The owner reconciles
  its stated spend against the ledger. A green suite is necessary and never sufficient for spend.
- HOLD any PR that removes rows from `out/translatv/spend_log.jsonl`.
- Never merge on a red or still pending required check.
- Merge with an ordinary merge commit (`merge_method: "merge"`), passing `expectedHeadSha` set to
  the head CI passed on.
- A PR whose description or a human review says it is held for the owner stays held unless the
  owner says, in this session, to merge that specific PR.
- A stacked PR (its base is another PR's branch) is never merged into that branch. It merges only
  after its base PR has landed on main, it has been retargeted to main, and CI is green again on
  the retargeted head.

**Git while fixing.**

- Fixes go on the PR's own head branch. The user invoking this loop is the authorization to push
  there, and only there. Never commit straight to main.
- Work in a separate worktree of the PR head, never in the session's own checkout.
- Never force push, rebase, or amend a commit that is already on the remote. A push that would
  need force is a STOP to report, not an obstacle.
- When a fix lands on a branch another open PR is stacked on, merge (never rebase) the updated
  base into the stacked branch and push it, so the stacked PR's CI runs against the fix.
- On a `spend_log.jsonl` conflict, keep both sides.
- Commit messages carry the why, per house style. Chat reports stay short.

---

## Running it on several PRs, or on all of them

1. List the open PRs. Report drafts and skip them unless they were named.
2. Launch every reviewer in a single message so they run concurrently, at most about 8 at a time.
   A PR over roughly 5,000 changed lines may be split across reviewers by area: each gets the
   full Part 2 brief scoped to its files, is told to walk every chain that starts in its area even
   when the chain leaves it, and gets the follow up rounds for fixes in its area.
3. Stacked PRs: brief each reviewer against the PR's own base, so the stacked PR's reviewer sees
   only its own diff. Fix the base PR first, propagate the fix by merge, then fix the stacked one.
4. Merge in dependency order, one PR at a time, re-reading mergeability after each merge.
5. Report one line per PR at the end: verdict, rounds run, merged (with the merge SHA) or held
   (with the gate that held it).

## Claude Code mechanics

- Spawn each reviewer with the Agent tool, `isolation: "worktree"` and `run_in_background: true`.
  Keep its agent id. Every follow up round goes to that same reviewer with SendMessage, so it
  keeps its context and can review only the delta.
- Add to every brief: before any checkout or mutation, run `git rev-parse --show-toplevel` and
  confirm it is not the main checkout. If a resumed round lands there, create a private worktree
  (`git worktree add --detach <scratch path> <sha>`) and work in it. Revert every mutation before
  reporting. Never push, comment on the PR, or edit its description.
- Tell concurrent reviewers they share the machine, so a timeout under load is only a finding if
  it reproduces when that test runs alone.
- Wait for each reviewer's completion notification. Never predict or report a result before it
  arrives.
- Only the main session pushes, edits PR descriptions, comments on PRs, or merges.

---

## Notes from running this

- **An approval is not automatically the end.** If every round so far has found something real,
  one more cheap round is usually worth it. Stop when a round finds nothing new, or when the only
  remaining findings are a different and smaller kind than the ones before.
- **When the same defect reappears one level out after you fix it, stop adding guards.** Two
  rounds of that means the instrument is wrong, not the coverage. Change instrument.
- **Your own fixes are the least reviewed code in the PR.** They are written fast, under the
  assumption that the finding was fully understood. Send them back.
- **Correct the description as you go.** A PR body that survived being wrong is worse than one
  that never claimed anything, because the next reader trusts it.
- Tell the reviewer to ignore external links (design docs, artifacts, tickets). The review has to
  stand on the diff.
- Budget: each round is real tokens and wall clock. Four rounds on a 5,000 line PR was worth it;
  four rounds on a 50 line PR would not be.
