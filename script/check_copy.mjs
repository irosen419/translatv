#!/usr/bin/env node
// House rule gate: the UI copy files are COMPLETE, and the dialect files are only differences.
//
// The failure this exists to prevent is a key that exists in English and nowhere else. The
// lookup falls back down the chain, so nothing crashes: a Spanish speaker mid call is simply
// handed an English sentence with no warning anywhere, which is the quiet kind of wrong this
// repo keeps refusing elsewhere. A gate is the only thing that catches it, because the code path
// that produces it looks perfectly healthy.
//
// Four things are checked, and each one was a way to be complete and still wrong:
//
//   MISSING     a key English has and a base language file does not. The English sentence ships.
//   EXTRA       a key a translation has and English does not. Nothing will ever ask for it, so
//               it is dead copy that reads as coverage.
//   UNKNOWN     a dialect override naming a key its base language does not have. Same as EXTRA,
//               except it also looks like the override is doing something.
//   NO OP       a dialect override whose string is character for character the base string. An
//               override file is a set of DIFFERENCES. One that restates its base has to be kept
//               in step by hand forever, and the day it falls behind it silently wins.
//
// Placeholders are checked too: a translation that drops {name} renders a sentence with nobody's
// name in it, which is a different sentence rather than a smaller one.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COPY_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "src", "i18n");
const ENGLISH = "en";
const PLACEHOLDER = /\{(\w+)\}/g;

function load(name) {
  return JSON.parse(readFileSync(join(COPY_DIR, `${name}.json`), "utf8"));
}

function placeholders(text) {
  return [...String(text).matchAll(PLACEHOLDER)].map((m) => m[1]).sort().join(",");
}

/** Base language files are "en" and "es"; a dialect file carries a region, as in "es-AR". */
function copyFiles() {
  const names = readdirSync(COPY_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  return {
    bases: names.filter((name) => !name.includes("-")),
    dialects: names.filter((name) => name.includes("-")),
  };
}

const { bases, dialects } = copyFiles();
const english = load(ENGLISH);
const englishKeys = Object.keys(english);
const problems = [];

if (englishKeys.length === 0) {
  problems.push(`${ENGLISH}.json is empty, so there is no copy to check against.`);
}

for (const [key, value] of Object.entries(english)) {
  if (typeof value !== "string" || value.trim() === "") {
    problems.push(`${ENGLISH}.json  ${key}  is empty, which renders as nothing at all`);
  }
}

for (const base of bases) {
  if (base === ENGLISH) continue;
  const table = load(base);

  for (const key of englishKeys) {
    if (!(key in table)) {
      problems.push(`${base}.json  ${key}  MISSING, so this reader gets the English sentence`);
      continue;
    }
    if (typeof table[key] !== "string" || table[key].trim() === "") {
      problems.push(`${base}.json  ${key}  is empty, which renders as nothing at all`);
      continue;
    }
    if (placeholders(table[key]) !== placeholders(english[key])) {
      problems.push(
        `${base}.json  ${key}  placeholders differ from English ` +
          `(${placeholders(english[key]) || "none"} vs ${placeholders(table[key]) || "none"})`,
      );
    }
  }

  for (const key of Object.keys(table)) {
    if (!(key in english)) {
      problems.push(`${base}.json  ${key}  EXTRA, no such key in ${ENGLISH}.json`);
    }
  }
}

for (const dialect of dialects) {
  const table = load(dialect);
  const language = dialect.split("-")[0];
  if (!bases.includes(language)) {
    problems.push(`${dialect}.json  has no base language file ${language}.json to override`);
    continue;
  }
  const base = load(language);

  for (const [key, value] of Object.entries(table)) {
    if (!(key in base)) {
      problems.push(`${dialect}.json  ${key}  UNKNOWN, no such key in ${language}.json`);
      continue;
    }
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${dialect}.json  ${key}  is empty, which renders as nothing at all`);
      continue;
    }
    if (value === base[key]) {
      problems.push(`${dialect}.json  ${key}  NO OP, identical to ${language}.json`);
    }
    if (placeholders(value) !== placeholders(base[key])) {
      problems.push(
        `${dialect}.json  ${key}  placeholders differ from ${language}.json ` +
          `(${placeholders(base[key]) || "none"} vs ${placeholders(value) || "none"})`,
      );
    }
  }
}

if (problems.length === 0) {
  const files = bases.length + dialects.length;
  console.log(
    `check:copy clean, ${englishKeys.length} keys across ${files} files, ` +
      `every language complete and every override a real difference.`,
  );
  process.exit(0);
}

console.error(`check:copy FAILED with ${problems.length} problem(s):\n`);
for (const problem of problems) console.error(`  ${problem}`);
console.error(
  "\nA missing key falls back to English silently, which is why this is a gate and not a warning.",
);
process.exit(1);
