---
name: review-and-merge-prs
description: "Review every open pull request on the repo in parallel, work out a conflict-safe merge order, run /review on each, and merge the ones the review approves while holding the rest. Use when the user says /review-and-merge-prs, or asks to review, triage, sweep, or clear out the open PRs and merge the good ones. For reviewing a single named PR, use /review directly instead."
---

## What this skill does

Given the open pull requests on the current repo, it:

1. Enumerates them, filtering out anything not eligible to merge.
2. Works out a merge order that will not create conflicts (and detects the cases that need rebasing).
3. Reviews each one with the `/review` skill, one background agent per PR.
4. Merges the PRs whose review says Approve/Merge; holds the rest.
5. Reports a per-PR table of verdict and outcome.

This is the generalized, repeatable form of: "spin off an agent per PR, confirm they would not conflict (and if they would, order them so each merges and rebases cleanly), review each with /review, merge if Approve/Merge, hold otherwise."

## Guardrails (read first)

- **Merging is irreversible and outward-facing.** The user asking to "merge the ones that pass" is standing authorization to merge PRs the review approves in this run. It is not authorization to force-push, close PRs, change base branches, or merge something the review did not approve. When in doubt, hold and report, do not merge.
- **Never report a PR as merged without confirming the merge API call returned `merged: true`.** Mirror the repo's own atomicity house rule: no success claim without the change actually landing.
- **Hold, do not guess.** Any verdict that is not clearly Approve/Merge (Request Changes, Comment, Hold, or anything ambiguous) means HOLD. A held PR is a safe outcome; a wrongly merged one is not.
- **Respect existing human signals.** If a PR already carries a human "changes requested" review, unresolved review threads, or a merge block, hold it even if the fresh `/review` is positive, and say why.
- **The repo's own CLAUDE.md is authoritative on merging.** Before merging any PR, consult the repo's CLAUDE.md (and any spec it points to) for repo-specific merge gates or hold-rules, and honor them even when the generic verdict is Approve/Merge. A repo may forbid auto-merging a class of change, require an extra check first, or demand a specific merge method. When such a rule applies and you cannot verify it is satisfied, hold the PR rather than merge. These repo rules add to, and can override, the defaults in this skill.

## Step 1: Enumerate eligible PRs

List open PRs (`list_pull_requests`, state open). Drop from the merge set, but still report as skipped:

- **Draft** PRs (`draft: true`).
- PRs whose `mergeable_state` is `dirty` (conflicts with base) or `blocked` (failing required checks / missing approvals). Note these explicitly, do not silently ignore.
- PRs not targeting the intended base (default `main`) unless the user said otherwise.

Review PRs from any author by default. Scope by author only when the user explicitly asks (for example only the owner's autopilot PRs).

If there are many PRs, cap live review agents at about 8 to 10 at a time and batch the rest; do not fan out 40 agents at once.

## Step 2: Determine a conflict-safe merge order

There are two independent kinds of conflict. Check both.

**a. Conflict with the base branch.** Read each PR's `mergeable`/`mergeable_state`. A `dirty` state means it already conflicts with `main` and cannot merge until the author (or you, if asked) rebases it. Hold these and report; do not try to merge them.

**b. Conflict between the PRs themselves.** Pull each PR's changed-file list (`get_files`). Two PRs can only textually conflict if their file sets intersect (a necessary, not sufficient, condition, but it is the cheap and reliable screen). Build the overlap graph:

- **No file overlap between any pair** (the common autopilot case): they are independent. Merge order does not matter; pick a stable order such as ascending PR number.
- **Some pairs overlap:** those form a cluster that must be merged one at a time with a rebase between them. Merge one member, then before merging the next overlapping member, update its branch onto the new base (`update_pull_request_branch`), re-fetch its `mergeable_state`, and only merge once it reports `clean`. If it cannot auto-rebase (the update leaves it `dirty`), stop on that PR, hold it, and report that it needs a manual rebase. Never force-resolve someone else's conflict silently.

State the resulting order and the reason (independent vs clustered) before merging anything.

## Step 3: Review each PR with /review

Spin off one background agent per eligible PR (see Step 1 cap). Each agent:

- Invokes the `/review` skill targeted at its PR number on this repo.
- Does NOT merge anything itself.
- Returns an unambiguous verdict: the review's recommendation, the key findings, and a one-word bottom line of `MERGE` or `HOLD`.

Give each agent the PR number, title, and touched files so it starts oriented. Launch the agents in a single message so they run concurrently.

Map verdicts to actions:

| Review recommendation | Action |
|---|---|
| Approve / Merge | Merge (subject to Step 2 order and Step 1 eligibility) |
| Request Changes | Hold |
| Comment / neutral / mixed | Hold |
| Ambiguous or errored | Hold |

## Step 4: Merge the approved PRs

Merge approved PRs in the Step 2 order. For each:

- Merge via `merge_pull_request` using an ordinary **merge commit** (this project's convention; do not switch to squash/rebase without asking).
- Confirm the response is `merged: true` before counting it done.
- For clustered/overlapping PRs, do the `update_pull_request_branch` + re-check dance from Step 2b between merges.
- **Post the review outcome as a PR comment on every PR, merged or held.** Include the verdict, the key findings, and the resulting action (merged, or held with the reason). This gives every PR an audit trail of why it was or was not merged.

## Step 5: Report

Give the user one table: PR number, title, review verdict, and outcome (merged with commit SHA, or held with the reason). Call out anything skipped in Step 1 (drafts, base conflicts) and anything held despite a positive review (Step 2 rebase needed, or a human block).

## Notes and edge cases

- **Already merged / closed between listing and merging:** skip silently, it is not an error.
- **CI:** the base repo may have no CI configured. If required checks exist and are failing, treat the PR as `blocked` and hold it. Do not merge over red required checks just because the code review was positive.
- **A PR that is fine on its own but its review flags a cross-PR interaction:** hold it and surface the interaction, since single-PR review agents each see only their own diff.
- **Do not create pull requests** as part of this skill; it only reviews and merges existing ones.
