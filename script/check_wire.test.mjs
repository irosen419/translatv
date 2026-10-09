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
});
