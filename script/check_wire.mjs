#!/usr/bin/env node
// Gate for shared/wire/: the golden fixtures and the generated schemas that the iOS app's hand
// written Swift is checked against (docs/PLAN.md, D7). Covers the WebSocket protocol and the HTTP
// account API alike.
//
// Fails, naming the file, when:
//   1. a fixture does not parse with its zod schema, or parsing would change it (unknown keys,
//      text the transforms would rewrite), since the Swift side round trips these bytes;
//   2. a fixture is refused by the COMMITTED exported schema, the file the Swift tests read, or
//      that schema does not compile under Ajv's strict mode. zod and the export disagreeing means
//      the export lost or invented a rule;
//   3. a member of either union, or a request or response in HTTP_ROUTES, has no fixture, or a
//      fixture names nothing;
//   4. fixtures/index.json disagrees with the files on disk;
//   5. a committed generated file (schema.json, http.schema.json, constants.json) differs from a
//      fresh generation, meaning shared/src changed and `npm run gen:wire` was not run.
//
// Reads the schemas from shared/dist, so `npm run build:shared` must run first (`npm run
// check:wire` does). `--wire <dir>` points it at another copy of the directory, which is how its
// own test proves each failure against a temporary copy instead of the real files.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv from "ajv";
import { generateWireFiles, loadShared, REPO, WIRE } from "./gen_wire.mjs";

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

/**
 * The committed exported schemas, compiled under strict mode, as a lookup from a definition name
 * to its validator. A file that is missing or does not compile is reported, and its fixtures are
 * then checked by zod alone.
 */
function exportedSchemas(wire, problems) {
  const ajv = new Ajv({ strict: true, allErrors: true });
  const loaded = {};
  for (const [id, file] of [
    ["ws", "schema.json"],
    ["http", "http.schema.json"],
  ]) {
    const path = join(wire, file);
    if (!existsSync(path)) continue; // reported as missing by the freshness check
    const document = readJson(path, problems);
    if (document === undefined) continue;
    try {
      ajv.addSchema(document, id);
      for (const name of Object.keys(document.definitions ?? {})) ajv.getSchema(`${id}#/definitions/${name}`);
      loaded[id] = true;
    } catch (error) {
      problems.push(`${display(path)}: does not compile under Ajv strict mode (${error.message})`);
    }
  }
  // undefined: that file could not be loaded (already reported). null: it has no such definition.
  return (id, name) => {
    if (!loaded[id]) return undefined;
    try {
      return ajv.getSchema(`${id}#/definitions/${name}`) ?? null;
    } catch {
      return null;
    }
  };
}

/** Parses one fixture with zod and with the exported schema, reporting every way it fails. */
function checkFixture(path, value, zodSchema, exported, schemaName, problems) {
  const parsed = zodSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    problems.push(`${display(path)}: fails the ${schemaName} schema at ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  } else if (!isDeepStrictEqual(parsed.data, value)) {
    problems.push(`${display(path)}: parses, but not to itself (an unknown key, or text the schema rewrites)`);
  }
  if (exported === undefined) return;
  if (exported === null) {
    problems.push(`${display(path)}: the exported schema has no definition ${schemaName}`);
  } else if (!exported(value)) {
    const error = exported.errors?.[0];
    problems.push(
      `${display(path)}: refused by the exported schema as ${schemaName} at ${error?.instancePath || "(root)"}: ${error?.message}`,
    );
  }
}

function jsonNames(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
        .sort()
    : [];
}

async function main() {
  const wire = wireDir();
  const shared = await loadShared();
  const problems = [];
  const fixtures = join(wire, "fixtures");
  const exported = exportedSchemas(wire, problems);
  const onDisk = {};

  for (const [side, union] of [
    ["client", shared.clientMessage],
    ["server", shared.serverMessage],
  ]) {
    const dir = join(fixtures, side);
    const names = jsonNames(dir);
    onDisk[side] = names;
    const validate = exported("ws", `${side}Message`);

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
      checkFixture(path, fixture, union, validate, `${side}Message`, problems);
    }
  }

  {
    const dir = join(fixtures, "http");
    const names = jsonNames(dir);
    onDisk.http = names;
    const wanted = new Map(shared.HTTP_FIXTURES.map((fixture) => [fixture.name, fixture.schema]));
    for (const name of wanted.keys()) {
      if (!names.includes(name)) {
        problems.push(`${display(join(dir, `${name}.json`))}: missing, so ${name} has no fixture`);
      }
    }
    for (const name of names) {
      const path = join(dir, `${name}.json`);
      const schemaName = wanted.get(name);
      if (schemaName === undefined) {
        problems.push(`${display(path)}: names no request or response in HTTP_ROUTES`);
        continue;
      }
      const fixture = readJson(path, problems);
      if (fixture === undefined) continue;
      const validate = exported("http", schemaName);
      checkFixture(path, fixture, shared.HTTP_SCHEMAS[schemaName], validate, schemaName, problems);
    }
  }

  const indexPath = join(fixtures, "index.json");
  const index = readJson(indexPath, problems);
  if (index !== undefined) {
    for (const side of ["client", "server", "http"]) {
      const listed = Array.isArray(index?.[side]) ? [...index[side]].sort() : null;
      if (!isDeepStrictEqual(listed, onDisk[side])) {
        problems.push(
          `${display(indexPath)}: "${side}" lists ${JSON.stringify(listed)} but the files are ${JSON.stringify(onDisk[side])}`,
        );
      }
    }
  }

  for (const [name, fresh] of Object.entries(await generateWireFiles())) {
    const path = join(wire, name);
    const committed = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (committed !== fresh) {
      problems.push(
        `${display(path)}: ${committed === null ? "missing" : "stale"}; run \`npm run gen:wire\` and commit the result`,
      );
    }
  }

  if (problems.length > 0) {
    console.error(`check:wire FAILED with ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const count = onDisk.client.length + onDisk.server.length;
  console.log(
    `check:wire ok: ${count} WebSocket and ${onDisk.http.length} HTTP fixtures parse with zod and the exported ` +
      "schemas, every message and route has them, and the generated files are current",
  );
}

main().catch((error) => {
  console.error(`check:wire FAILED: ${error.message}`);
  process.exit(2);
});
