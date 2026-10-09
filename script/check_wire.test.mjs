// check_wire.mjs is a gate, and a gate that cannot fail looks exactly like a clean repository. So
// each way it is meant to fail is proved here once, against a temporary COPY of shared/wire, never
// by deleting or editing the real files.
//
// It imports the schemas from shared/dist, so `npm run build:shared` must have run first. `npm
// test` does that before any suite.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_WIRE = join(HERE, "..", "shared", "wire");
const CHECK = join(HERE, "check_wire.mjs");

let wire;

function run(dir) {
  return spawnSync(process.execPath, [CHECK, "--wire", dir], { encoding: "utf8" });
}

beforeEach(() => {
  wire = mkdtempSync(join(tmpdir(), "check-wire-"));
  cpSync(REAL_WIRE, wire, { recursive: true });
});

afterEach(() => {
  rmSync(wire, { recursive: true, force: true });
});

describe("check_wire.mjs", () => {
  it("passes on an untouched copy of the committed wire directory", () => {
    const result = run(wire);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("passes on the real directory with no arguments", () => {
    // execFileSync throws on a nonzero exit, which is the assertion.
    execFileSync(process.execPath, [CHECK], { encoding: "utf8" });
  });

  it("fails, naming the message type, when a fixture is missing", () => {
    unlinkSync(join(wire, "fixtures", "server", "pong.json"));
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/pong/);
  });

  it("fails, naming the file, when a fixture does not parse with its schema", () => {
    const path = join(wire, "fixtures", "client", "stt.final.json");
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...fixture, seq: -1 }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/stt\.final\.json/);
  });

  it("fails when index.json disagrees with the files on disk", () => {
    const path = join(wire, "fixtures", "index.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.client = index.client.filter((t) => t !== "ping");
    writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/index\.json/);
  });

  it("fails when the committed schema.json is stale", () => {
    const path = join(wire, "schema.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("\n", '\n  "stale": true,\n'));
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema\.json/);
  });

  it("fails when a fixture carries a dialect outside the enum", () => {
    const path = join(wire, "fixtures", "server", "peer.updated.json");
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...fixture, dialect: "xx-YY" }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/peer\.updated\.json/);
  });

  it("fails when a fixture carries text over its limit", () => {
    const path = join(wire, "fixtures", "client", "chat.send.json");
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...fixture, text: "a".repeat(2001) }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/chat\.send\.json/);
  });

  it("fails, naming the route, when an HTTP route has no fixture", () => {
    // Taken out of the index too, so the index check cannot be what catches it.
    unlinkSync(join(wire, "fixtures", "http", "me.contacts.response.json"));
    const path = join(wire, "fixtures", "index.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.http = index.http.filter((name) => name !== "me.contacts.response");
    writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/me\.contacts\.response\.json: missing/);
  });

  it("fails when a committed schema does not compile under Ajv strict mode", () => {
    // The nonstandard top level keyword the old schema.json carried, which strict mode refuses.
    const path = join(wire, "schema.json");
    const schema = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...schema, protocolVersion: 2 }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/schema\.json: does not compile under Ajv strict mode/);
  });

  it("fails, naming the file, when an HTTP fixture does not parse", () => {
    const path = join(wire, "fixtures", "http", "me.preferences.put.request.json");
    writeFileSync(path, JSON.stringify({ dialect: "xx-YY", uiDialect: null }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/me\.preferences\.put\.request\.json/);
  });

  it("fails when an HTTP fixture is not canonical", () => {
    const path = join(wire, "fixtures", "http", "auth.login.request.json");
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...fixture, email: fixture.email.toUpperCase() }, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/auth\.login\.request\.json/);
  });

  it("fails when index.json leaves out an HTTP fixture", () => {
    const path = join(wire, "fixtures", "index.json");
    const index = JSON.parse(readFileSync(path, "utf8"));
    index.http = index.http.filter((name) => name !== "healthz.response");
    writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/index\.json/);
  });

  it.each(["http.schema.json", "constants.json"])("fails when the committed %s is stale", (name) => {
    // A change every reader still accepts (a reworded description or comment), so freshness is
    // the only check that can object: an unknown keyword would fail Ajv strict mode instead.
    const path = join(wire, name);
    const before = readFileSync(path, "utf8");
    const after = before.replace(/"(\$comment|description)": "GENERATED/, '"$1": "Hand edited. GENERATED');
    expect(after).not.toBe(before);
    writeFileSync(path, after);
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${name}: stale`);
    expect(result.stderr).not.toMatch(/strict mode|refused by the exported schema/);
  });

  it("fails when an HTTP fixture the zod schema accepts is refused by the exported HTTP schema", () => {
    const path = join(wire, "http.schema.json");
    const schema = JSON.parse(readFileSync(path, "utf8"));
    schema.definitions.dialectCode.enum = schema.definitions.dialectCode.enum.filter((code) => code !== "es-AR");
    writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/me\.preferences\.put\.request\.json: refused by the exported schema/);
  });

  it("fails when a fixture the zod schema accepts is refused by the exported schema", () => {
    // The two can disagree only if the export loses or invents a rule. Fixtures are validated
    // against the COMMITTED files, the ones the Swift tests read, so a hand narrowed schema.json
    // is reported for refusing the fixture as well as for being stale.
    const path = join(wire, "schema.json");
    const schema = JSON.parse(readFileSync(path, "utf8"));
    schema.definitions.dialectCode.enum = schema.definitions.dialectCode.enum.filter((code) => code !== "es-AR");
    writeFileSync(path, JSON.stringify(schema, null, 2) + "\n");
    const result = run(wire);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/room\.create\.json: refused by the exported schema/);
  });
});
