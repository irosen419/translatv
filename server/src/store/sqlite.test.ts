// node:sqlite prints an ExperimentalWarning on load. The loader drops exactly that one warning
// and nothing else, so a different experimental feature still announces itself.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isSqliteExperimentalWarning } from "./sqlite.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("isSqliteExperimentalWarning", () => {
  it("matches the SQLite experimental warning", () => {
    expect(
      isSqliteExperimentalWarning(
        "SQLite is an experimental feature and might change at any time",
        "ExperimentalWarning",
      ),
    ).toBe(true);
    expect(
      isSqliteExperimentalWarning(
        new Error("SQLite is an experimental feature and might change at any time"),
        { type: "ExperimentalWarning" },
      ),
    ).toBe(true);
  });

  it("lets every other warning through", () => {
    expect(isSqliteExperimentalWarning("VM Modules is an experimental feature", "ExperimentalWarning")).toBe(false);
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", "DeprecationWarning")).toBe(false);
    expect(isSqliteExperimentalWarning("SQLite is an experimental feature", undefined)).toBe(false);
  });
});

describe("loading node:sqlite through the store", () => {
  it("prints no SQLite experimental warning on a real Node process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        `import(${JSON.stringify(join(here, "store.ts"))}).then(m => { m.openStore({ path: ":memory:" }).close(); console.log("opened"); })`,
      ],
      { encoding: "utf8", cwd: join(here, "..", "..") },
    );
    expect(result.stdout).toContain("opened");
    expect(result.stderr).not.toContain("SQLite is an experimental feature");
  });
});
