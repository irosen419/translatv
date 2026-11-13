// check_secrets.mjs is a gate, so each way it is meant to fail is proved here, against a
// temporary stand in for a built client, never the real client/dist.
//
// The split deploy (DEPLOY.md, "Two services") builds the client with VITE_API_ORIGIN, which is
// inlined into the bundle on purpose because it is a public address. These tests pin both halves:
// that public value passes, and a secret behind VITE_ still fails, in whichever directory the
// build went to.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "check_secrets.mjs");

let dist;

function run(dir) {
  return spawnSync(process.execPath, [CHECK, "--dist", dir], { encoding: "utf8" });
}

function bundle(text) {
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "assets", "index.js"), text);
}

beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "check-secrets-"));
});

afterEach(() => {
  rmSync(dist, { recursive: true, force: true });
});

describe("check_secrets.mjs", () => {
  it("passes a split build, whose bundle carries the public API origin", () => {
    bundle('const API_ORIGIN="https://api.example.com";fetch(`${API_ORIGIN}/api/auth/login`);');
    const result = run(dist);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("clean");
  });

  it("fails on an Anthropic key in the bundle", () => {
    // Assembled at run time so this file never contains a key shaped string itself.
    bundle(`const k="${["sk", "ant", "api03"].join("-")}${"A".repeat(24)}";`);
    const result = run(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Anthropic API key");
  });

  it("fails on a secret named behind VITE_, in whatever directory the build went to", () => {
    bundle('const e={VITE_API_ORIGIN:"https://api.example.com",VITE_ANTHROPIC_API_KEY:"x"};');
    const result = run(dist);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("inlined VITE_ secret");
  });

  it("does not mistake VITE_API_ORIGIN itself for a secret", () => {
    bundle('const e={VITE_API_ORIGIN:"https://api.example.com"};');
    expect(run(dist).status).toBe(0);
  });

  it("fails, rather than passing, when the directory does not exist", () => {
    const result = run(join(dist, "nope"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not run");
  });
});
