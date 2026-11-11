// build:static refuses to produce a static bundle with no API origin, which would send every
// request to the static host itself. (The full build is exercised by the split end to end run.)

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build_static.mjs");

describe("build_static.mjs", () => {
  it.each([[""], ["   "]])("refuses to build without VITE_API_ORIGIN (%j)", (value) => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, VITE_API_ORIGIN: value },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("VITE_API_ORIGIN");
  });
});
