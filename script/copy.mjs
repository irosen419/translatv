// Read the app's copy files, for the scripts that drive the real UI.
//
// e2e.mjs and shots.mjs click buttons by the words on them, and the words are now whichever
// language that page's dialect picker is set to. Hardcoding English worked right up until the
// person being simulated chose Spanish, which is the whole feature.
//
// This resolves the same chain the client does (exact dialect, then base language, then English)
// and it is deliberately the ONLY second implementation of it. It reads the same JSON files
// rather than a copy of them, so it cannot disagree about the words; what it duplicates is nine
// lines of lookup, and the alternative is a build step so a .mjs harness can import a .ts module.
// client/src/i18n/copy.ts owns the real one, and copy.test.ts tests it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "client", "src", "i18n");

function load(name) {
  try {
    return JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8"));
  } catch {
    return null; // no file for that dialect or language, which is not an error
  }
}

/**
 * The words one dialect reads, as a lookup by key. `{name}` placeholders are filled from `params`
 * when given, the way the client's own interpolate does, so a harness can look for the exact
 * sentence a person reads ("Block Kit?") rather than a fragment of it.
 */
export function copyFor(dialect) {
  const tables = [load(dialect), load(dialect.split("-")[0]), load("en")].filter(Boolean);
  return (key, params) => {
    for (const table of tables) {
      if (table[key] === undefined) continue;
      const text = table[key];
      return params ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole)) : text;
    }
    throw new Error(`no copy for ${key}`);
  };
}
