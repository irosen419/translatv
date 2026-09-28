#!/usr/bin/env node
// Gate for shared/wire/: the golden fixtures and the generated JSON Schema that the iOS app's
// hand written Swift protocol is checked against (docs/PLAN.md, D7).
//
// Fails, naming the file, when:
//   1. a fixture does not parse with its schema, or parsing would change it (unknown keys, text
//      the transforms would rewrite), since the Swift side round trips these bytes;
//   2. a member of either union has no fixture, or a fixture names no member;
//   3. fixtures/index.json disagrees with the files on disk;
//   4. the committed schema.json differs from a fresh generation, meaning protocol.ts changed and
//      `npm run gen:wire` was not run.
//
// Reads the schemas from shared/dist, so `npm run build:shared` must run first (`npm run
// check:wire` does). `--wire <dir>` points it at another copy of the directory, which is how its
// own test proves each failure against a temporary copy instead of the real files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { generateSchemaText, loadShared, REPO, WIRE } from "./gen_wire.mjs";

function wireDir() {
  const at = process.argv.indexOf("--wire");
  if (at === -1) return WIRE;
  const dir = process.argv[at + 1];
  if (!dir) throw new Error("--wire needs a directory");
  return dir;
}

function display(path) {
  const rel = relative(REPO, path);
  return rel.startsWith("..") ? path : rel;
}

function readJson(path, problems) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    problems.push(`${display(path)}: not readable JSON (${error.message})`);
    return undefined;
  }
}

function typesOf(union) {
  return union.options.map((option) => option.shape.t.value);
}

async function main() {
  const wire = wireDir();
  const shared = await loadShared();
  const problems = [];
  const fixtures = join(wire, "fixtures");
  const onDisk = {};

  for (const [side, union] of [
    ["client", shared.clientMessage],
    ["server", shared.serverMessage],
  ]) {
    const dir = join(fixtures, side);
    const files = existsSync(dir)
      ? readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
      : [];
    const names = files.map((name) => name.slice(0, -".json".length));
    onDisk[side] = names;

    for (const t of typesOf(union)) {
      if (!names.includes(t)) {
        problems.push(`${display(join(dir, `${t}.json`))}: missing, so ${side} message "${t}" has no fixture`);
      }
    }

    for (const name of names) {
      const path = join(dir, `${name}.json`);
      const fixture = readJson(path, problems);
      if (fixture === undefined) continue;
      if (fixture?.t !== name) {
        problems.push(`${display(path)}: its t is ${JSON.stringify(fixture?.t)}, expected "${name}"`);
        continue;
      }
      const parsed = union.safeParse(fixture);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        problems.push(
          `${display(path)}: fails the ${side}Message schema at ${issue.path.join(".") || "(root)"}: ${issue.message}`,
        );
      } else if (!isDeepStrictEqual(parsed.data, fixture)) {
        problems.push(
          `${display(path)}: parses, but not to itself (an unknown key, or text the schema rewrites)`,
        );
      }
    }
  }

  const indexPath = join(fixtures, "index.json");
  const index = readJson(indexPath, problems);
  if (index !== undefined) {
    for (const side of ["client", "server"]) {
      const listed = Array.isArray(index?.[side]) ? [...index[side]].sort() : null;
      if (!isDeepStrictEqual(listed, onDisk[side])) {
        problems.push(
          `${display(indexPath)}: "${side}" lists ${JSON.stringify(listed)} but the files are ${JSON.stringify(onDisk[side])}`,
        );
      }
    }
  }

  const schemaPath = join(wire, "schema.json");
  const fresh = await generateSchemaText();
  const committed = existsSync(schemaPath) ? readFileSync(schemaPath, "utf8") : null;
  if (committed !== fresh) {
    problems.push(
      `${display(schemaPath)}: ${committed === null ? "missing" : "stale"}; run \`npm run gen:wire\` and commit the result`,
    );
  }

  if (problems.length > 0) {
    console.error(`check:wire FAILED with ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const count = onDisk.client.length + onDisk.server.length;
  console.log(`check:wire ok: ${count} fixtures parse, every message has one, schema.json is current`);
}

main().catch((error) => {
  console.error(`check:wire FAILED: ${error.message}`);
  process.exit(2);
});
