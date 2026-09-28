// The production boot guard for the database, the counterpart of the ephemeral ledger guard.
//
// The device check is given an injected stat so these tests do not depend on how the machine
// running them happens to lay out its filesystems.

import { describe, expect, it } from "vitest";
import { ephemeralDataRefusal, isEphemeralDataDir } from "./guard.js";

const ROOT_DEV = 1;

/** A fake filesystem: path to device number, where a missing path throws like statSync. */
function statFrom(devices: Record<string, number>) {
  return (path: string): { dev: number } => {
    const dev = devices[path];
    if (dev === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    return { dev };
  };
}

describe("isEphemeralDataDir", () => {
  it("is true when the data directory is on the root device", () => {
    const stat = statFrom({ "/": ROOT_DEV, "/app/data": ROOT_DEV });
    expect(isEphemeralDataDir("/app/data", stat)).toBe(true);
  });

  it("is false when the data directory is a mount", () => {
    const stat = statFrom({ "/": ROOT_DEV, "/app/data": 7 });
    expect(isEphemeralDataDir("/app/data", stat)).toBe(false);
  });

  it("judges a missing directory by the nearest existing ancestor, where it would be created", () => {
    expect(isEphemeralDataDir("/app/data", statFrom({ "/": ROOT_DEV, "/app": ROOT_DEV }))).toBe(true);
    expect(isEphemeralDataDir("/app/data", statFrom({ "/": ROOT_DEV, "/app": 7 }))).toBe(false);
  });

  it("says no when it cannot tell, rather than block a boot over an unanswerable question", () => {
    expect(isEphemeralDataDir("/app/data", statFrom({}))).toBe(false);
  });
});

describe("ephemeralDataRefusal", () => {
  it("refuses in production on the image layer, naming the reason and the override", () => {
    const message = ephemeralDataRefusal({ isProduction: true, ephemeral: true, allow: undefined });
    expect(message).toContain("database is on the image layer");
    expect(message).toContain("ALLOW_EPHEMERAL_DATA=1");
  });

  it("allows production on the image layer when ALLOW_EPHEMERAL_DATA is set", () => {
    expect(ephemeralDataRefusal({ isProduction: true, ephemeral: true, allow: "1" })).toBeNull();
  });

  it("treats a blank override as unset", () => {
    expect(ephemeralDataRefusal({ isProduction: true, ephemeral: true, allow: " " })).not.toBeNull();
  });

  it("allows production on a mount", () => {
    expect(ephemeralDataRefusal({ isProduction: true, ephemeral: false, allow: undefined })).toBeNull();
  });

  it("never refuses outside production", () => {
    expect(ephemeralDataRefusal({ isProduction: false, ephemeral: true, allow: undefined })).toBeNull();
  });
});
