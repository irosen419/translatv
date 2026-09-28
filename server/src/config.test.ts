// Boot configuration, with the emphasis on the cases where a half set variable is worse than an
// unset one. An unset TURN_URL is a documented degraded mode that the boot log names. A TURN_URL
// with no credentials is a MISTAKE, and the damage is that it looks exactly like success.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "./config.js";

// A repo root with no .env in it, so these tests read the environment and nothing else. Pointing
// at the real repo root would let a developer's own .env decide whether the suite passes.
let root: string;
const TURN_VARS = ["TURN_URL", "TURN_USERNAME", "TURN_CREDENTIAL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vt-config-"));
  saved = {};
  for (const name of TURN_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TURN_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});

/** The thrown message, or "" if loadConfig did not throw. Lets a test assert on which
 * variables the message names rather than only that something was thrown. */
function thrownMessage(): string {
  try {
    loadConfig(root);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("TURN configuration", () => {
  it("is absent by default, leaving STUN only", () => {
    const config = loadConfig(root);
    expect(config.iceServers).toHaveLength(1);
    expect(describeConfig(config).join("\n")).toContain("STUN only");
  });

  it("is carried through when the URL and both credentials are set", () => {
    process.env["TURN_URL"] = "turn:standard.relay.metered.ca:80";
    process.env["TURN_USERNAME"] = "user";
    process.env["TURN_CREDENTIAL"] = "secret";

    const config = loadConfig(root);
    expect(config.iceServers).toHaveLength(2);
    expect(config.iceServers[1]).toEqual({
      urls: "turn:standard.relay.metered.ca:80",
      username: "user",
      credential: "secret",
    });
    expect(describeConfig(config).join("\n")).toContain("STUN and TURN");
  });

  // The bug this file was written for. A TURN_URL with no credentials used to produce a TURN
  // entry with empty strings in it, and the boot log then reported "STUN and TURN". Every relay
  // allocation is rejected for missing credentials, so the exact 10 to 15 percent of calls TURN
  // exists to carry still failed, while the boot log said the opposite. Refusing is the only
  // honest answer: nobody sets TURN_URL by accident, so this is always a mistake to be fixed.
  // These assert on WHICH variable the message names, not merely that it threw.
  //
  // The first version of these tests only checked that something was thrown. That was worthless:
  // the message used to end with "set all three of TURN_URL, TURN_USERNAME and TURN_CREDENTIAL",
  // so every message contained every name and any throw satisfied any assertion. Review mutated
  // the dynamic half to name the FIRST missing variable, then to name NOTHING, then to name
  // TURN_URL every time, and all three mutations passed the suite. Naming the wrong variable is
  // the failure mode that actually wastes someone's time, so each case now pins the names that
  // must be present AND the ones that must not.
  it("names the username when only the username is missing", () => {
    process.env["TURN_URL"] = "turn:standard.relay.metered.ca:80";
    process.env["TURN_CREDENTIAL"] = "secret";
    const message = thrownMessage();
    expect(message).toContain("TURN_USERNAME");
    expect(message).not.toContain("TURN_CREDENTIAL");
    expect(message).not.toContain("TURN_URL");
  });

  it("names the credential when only the credential is missing", () => {
    process.env["TURN_URL"] = "turn:standard.relay.metered.ca:80";
    process.env["TURN_USERNAME"] = "user";
    const message = thrownMessage();
    expect(message).toContain("TURN_CREDENTIAL");
    expect(message).not.toContain("TURN_USERNAME");
    expect(message).not.toContain("TURN_URL");
  });

  it("names the URL when credentials are set without one", () => {
    // The other direction of the same mistake. Silently dropping these means someone who
    // fat fingered the URL variable name gets STUN only and a boot log that agrees with it.
    process.env["TURN_USERNAME"] = "user";
    process.env["TURN_CREDENTIAL"] = "secret";
    const message = thrownMessage();
    expect(message).toContain("TURN_URL");
    expect(message).not.toContain("TURN_USERNAME");
    expect(message).not.toContain("TURN_CREDENTIAL");
  });

  // Whitespace is not a credential. A variable set to spaces is the shape a broken deploy
  // template produces, and it must not read as set.
  it("treats a whitespace only credential as missing", () => {
    process.env["TURN_URL"] = "turn:standard.relay.metered.ca:80";
    process.env["TURN_USERNAME"] = "user";
    process.env["TURN_CREDENTIAL"] = "   ";
    expect(thrownMessage()).toContain("TURN_CREDENTIAL");
  });

  it("names every missing variable at once, not just the first", () => {
    // So a deploy is fixed in one pass rather than one restart per missing variable.
    process.env["TURN_URL"] = "turn:standard.relay.metered.ca:80";
    const message = thrownMessage();
    expect(message).toContain("TURN_USERNAME");
    expect(message).toContain("TURN_CREDENTIAL");
  });
});

describe("DATA_DIR", () => {
  let savedDataDir: string | undefined;
  beforeEach(() => {
    savedDataDir = process.env["DATA_DIR"];
    delete process.env["DATA_DIR"];
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env["DATA_DIR"];
    else process.env["DATA_DIR"] = savedDataDir;
  });

  it("defaults to data/ under the repo root, holding translatv.db", () => {
    const config = loadConfig(root);
    expect(config.dataDir).toBe(join(root, "data"));
    expect(config.databasePath).toBe(join(root, "data", "translatv.db"));
  });

  it("takes an absolute DATA_DIR as given", () => {
    process.env["DATA_DIR"] = "/srv/translatv";
    const config = loadConfig(root);
    expect(config.dataDir).toBe("/srv/translatv");
    expect(config.databasePath).toBe("/srv/translatv/translatv.db");
  });

  it("resolves a relative DATA_DIR against the repo root, not the working directory", () => {
    process.env["DATA_DIR"] = "state";
    expect(loadConfig(root).dataDir).toBe(join(root, "state"));
  });

  it("treats a blank DATA_DIR as unset", () => {
    process.env["DATA_DIR"] = "  ";
    expect(loadConfig(root).dataDir).toBe(join(root, "data"));
  });
});

describe("accounts configuration", () => {
  const NAMES = ["AUTH_SECRET", "SIGNUP_MODE", "OWNER_EMAIL"] as const;
  let savedAccounts: Record<string, string | undefined>;
  beforeEach(() => {
    savedAccounts = {};
    for (const name of NAMES) {
      savedAccounts[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const name of NAMES) {
      if (savedAccounts[name] === undefined) delete process.env[name];
      else process.env[name] = savedAccounts[name];
    }
  });

  it("defaults to invite only signup, no owner, and no secret", () => {
    const config = loadConfig(root);
    expect(config.signupMode).toBe("invite");
    expect(config.ownerEmail).toBe(null);
    expect(config.authSecret).toBe(null);
  });

  it("reads open signup", () => {
    process.env["SIGNUP_MODE"] = "open";
    expect(loadConfig(root).signupMode).toBe("open");
  });

  it("refuses a SIGNUP_MODE it does not know rather than guessing which one was meant", () => {
    // A typo that fell back to "open" would hand the owner's spend cap to strangers.
    process.env["SIGNUP_MODE"] = "opne";
    expect(thrownMessage()).toContain("SIGNUP_MODE");
  });

  it("normalizes OWNER_EMAIL the way signup normalizes an email", () => {
    process.env["OWNER_EMAIL"] = "  Owner@Example.TEST ";
    expect(loadConfig(root).ownerEmail).toBe("owner@example.test");
  });

  it("carries AUTH_SECRET, and says so without printing it", () => {
    const secret = "f".repeat(64);
    process.env["AUTH_SECRET"] = secret;
    const config = loadConfig(root);
    expect(config.authSecret).toBe(secret);
    expect(describeConfig(config).join("\n")).not.toContain(secret);
  });

  it("no longer reads ADMIN_PASSWORD at all", () => {
    expect("adminPassword" in loadConfig(root)).toBe(false);
  });
});
