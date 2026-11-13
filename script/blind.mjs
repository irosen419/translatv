#!/usr/bin/env node
// The blind model comparison: `npm run blind`. See TESTING.md and src/eval/blind/cli.ts.
//
// Deliberately thin. Everything that can be tested lives in server/src/eval/blind/ and is tested
// there (a dry run end to end included); this file only hands it the process. Via tsx, NOT bare
// node, for the reason verify_translation.mjs gives: the server's .ts modules need it.
//
// It SPENDS MONEY unless --dry-run is given: every call is appended to
// out/translatv/spend_log.jsonl under the "blind-test" program, against a hard budget.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const { main } = await import(`${REPO}/server/src/eval/blind/cli.ts`);

const code = await main(process.argv.slice(2), process.env, {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  repoRoot: REPO,
  signals: true,
});
process.exit(code);
