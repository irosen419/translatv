#!/usr/bin/env node
// Does the committed spend view still agree with the ledger it is generated from?
//
// This exists because it did not, and nothing noticed. spend_log.md was rendered once at the
// scaffold commit and never again, so a file committed to this repository read "Known spend
// $0.0000 across 0 calls" while the ledger beside it held 111 calls and real money. Anyone
// reading the generated view concluded the project had spent nothing.
//
// RefusedWrite cannot catch that: it guards the opposite direction, an empty ledger overwriting
// a real view. This is the check for the direction that actually happened.
//
// Deliberately a comparison and not a regeneration. A check that quietly fixed the file would
// leave the working tree dirty and, worse, would let a stale view sail through CI unnoticed,
// which is the failure being prevented. Report and fail; the fix is one documented command.
//
// No em dashes or en dashes anywhere.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewPath = join(repoRoot, "out", "translatv", "spend_log.md");
const ledgerPath = join(repoRoot, "out", "translatv", "spend_log.jsonl");

if (!existsSync(ledgerPath)) {
  // A missing ledger is not this script's business to interpret. The runtime already refuses to
  // spend against one, loudly, and inventing a verdict here would only add a second opinion.
  console.log("check:spend-view skipped, no ledger present.");
  process.exit(0);
}

// Rendered by the Python reader rather than the TypeScript one on purpose: this script has no
// build step of its own, and rendering with ledger.ts here would need one (compiling it, or
// running it through tsx). spend_log.py needs neither.
//
// That substitution is only safe because the two are proven to render identically:
// server/src/spend/ledger.test.ts spawns this same `render` subcommand against the shared
// fixture at test_fixtures/ledger_root and asserts its output is byte identical, modulo the one
// newline print() adds on top, to renderMarkdown()'s return value for that fixture. That test is
// the guarantee, not the fixture. The fixture by itself is a shared INPUT: ledger.test.ts and
// test_spend_log.py each assert their own expected numbers against it in parallel, and neither
// one runs the other language's renderer, so agreement between the two files was never actually
// checked until that parity test existed.
const rendered = spawnSync("python3", [join(repoRoot, "spend_log.py"), "render"], {
  cwd: repoRoot,
  encoding: "utf8",
});

if (rendered.status !== 0) {
  console.error("check:spend-view FAILED, could not render the view:");
  console.error(rendered.stderr.trim());
  process.exit(1);
}

const actual = existsSync(viewPath) ? readFileSync(viewPath, "utf8") : "";

if (actual.trim() === rendered.stdout.trim()) {
  console.log("check:spend-view clean, the committed view matches the ledger.");
  process.exit(0);
}

console.error("check:spend-view FAILED: spend_log.md disagrees with spend_log.jsonl.");
console.error("");
console.error("The generated view is stale, which means a file committed to this repository is");
console.error("stating a spend figure that is not true. Regenerate it:");
console.error("");
console.error("  python3 spend_log.py render --execute");
console.error("");
process.exit(1);
