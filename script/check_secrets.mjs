#!/usr/bin/env node
// Build gate: no API key ever reaches the client bundle.
//
// The specific trap this exists for: Vite inlines every environment variable named VITE_*
// into the built JavaScript. Naming the key VITE_ANTHROPIC_API_KEY would ship it to every
// visitor with no error and no warning, and the bundle is public by definition. Grepping the
// built output is the only check that catches it, because the source looks fine either way.
//
// Runs against client/dist after a build. A missing dist is not a pass: it means the check
// did not actually run, and reporting success for a check that did not run is the failure
// mode this file is meant to prevent.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "client/dist";

// Prefixes that identify a real credential in built output. Kept narrow on purpose: a broad
// pattern like /key/ would match minified variable names on every build and train everyone
// to ignore the gate.
const PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "OpenAI API key", re: /sk-[A-Za-z0-9]{32,}/ },
  { name: "Google API key", re: /AIza[A-Za-z0-9_-]{30,}/ },
  { name: "inlined VITE_ secret", re: /VITE_[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|CREDENTIAL)/ },
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

if (!existsSync(DIST)) {
  console.error(`check:secrets could not run: ${DIST} does not exist.`);
  console.error("Build the client first (npm run build), then re-run this check.");
  console.error("A check that did not run is not a check that passed.");
  process.exit(1);
}

const hits = [];
for (const file of walk(DIST)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // binary asset
  }
  for (const { name, re } of PATTERNS) {
    const match = text.match(re);
    if (match) hits.push({ file, name, sample: `${match[0].slice(0, 12)}...` });
  }
}

if (hits.length === 0) {
  console.log("check:secrets clean, no credentials found in the client bundle.");
  process.exit(0);
}

console.error(`check:secrets FAILED, ${hits.length} credential(s) in the client bundle:\n`);
for (const hit of hits) {
  console.error(`  ${hit.file}: ${hit.name} (${hit.sample})`);
}
console.error("\nA key in the bundle is public. Rotate it, then move it server side.");
process.exit(1);
