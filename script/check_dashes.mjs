#!/usr/bin/env node
// House rule gate: zero em dashes (U+2014) and en dashes (U+2013) anywhere in tracked source.
//
// The rule covers comments, strings, prompts, and docs, not just prose, because a dash that
// reaches an LLM prompt or a rendered subtitle is exactly as much a violation as one in a
// heading. Reports every hit with a file, a line number, and the offending line, so a failure
// is fixable without re-running a search by hand.
//
// Uses git ls-files rather than a directory walk, so ignored and untracked build output is
// out of scope by construction and this cannot fail on node_modules.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM_DASH = "—";
const EN_DASH = "–";

// Binary and lockfile extensions where a dash is neither meaningful nor editable by hand.
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".wav", ".zip", ".gz",
]);

const SKIP_FILES = new Set([
  "package-lock.json",
  "script/check_dashes.mjs", // declares the characters it searches for
]);

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter((path) => path.length > 0);
}

function shouldSkip(path) {
  if (SKIP_FILES.has(path)) return true;
  const dot = path.lastIndexOf(".");
  return dot !== -1 && SKIP_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function findings(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // unreadable or binary, not a dash problem
  }
  if (!text.includes(EM_DASH) && !text.includes(EN_DASH)) return [];

  const hits = [];
  text.split("\n").forEach((line, index) => {
    if (line.includes(EM_DASH) || line.includes(EN_DASH)) {
      hits.push({ path, line: index + 1, text: line.trim() });
    }
  });
  return hits;
}

const hits = trackedFiles().filter((path) => !shouldSkip(path)).flatMap(findings);

if (hits.length === 0) {
  console.log("check:dashes clean, zero em or en dashes in tracked source.");
  process.exit(0);
}

console.error(`check:dashes FAILED with ${hits.length} occurrence(s):\n`);
for (const hit of hits) {
  console.error(`  ${hit.path}:${hit.line}  ${hit.text.slice(0, 120)}`);
}
console.error("\nReplace each with a comma, a period, a colon, or parentheses.");
process.exit(1);
