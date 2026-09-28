// The invite CLI, run the way the owner runs it: its own process, against the database file,
// usually beside a live server.
//
// A separate process rather than an imported function, because what broke was what the process
// did on its way in. It built an AuthService to mint the code, and that constructor makes the
// owner flag agree with OWNER_EMAIL, so run from a shell with no OWNER_EMAIL it quietly demoted
// the live owner, who then got 403 minting invites until the server restarted.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { AuthService } from "../auth/service.js";
import { openStore } from "../store/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const OWNER = "owner@example.test";
const PASSWORD = "a long enough password";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run fn against an AuthService on the file, then close it. */
async function withAuth<T>(path: string, signupMode: "open" | "invite", fn: (auth: AuthService) => Promise<T>): Promise<T> {
  const store = openStore({ path });
  try {
    return await fn(new AuthService(store, { secret: "s".repeat(40), signupMode, ownerEmail: OWNER }));
  } finally {
    store.close();
  }
}

it("mints a code that signs someone up, and leaves the owner alone when OWNER_EMAIL is not set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tv-invite-"));
  dirs.push(dir);
  const path = join(dir, "translatv.db");

  const owner = await withAuth(path, "open", (auth) =>
    auth.signup({ email: OWNER, password: PASSWORD, displayName: "Owner" }, Date.now()),
  );
  expect(owner.ok && owner.value.user.isOwner).toBe(true);

  // OWNER_EMAIL set but EMPTY, rather than deleted: a real variable wins over a .env in the
  // checkout, so this is "not set" on every machine, a developer's included.
  const result = spawnSync(process.execPath, ["--import", "tsx", join(here, "invite.ts")], {
    encoding: "utf8",
    cwd: join(here, "..", ".."),
    env: { ...process.env, DATA_DIR: dir, OWNER_EMAIL: "", NODE_ENV: "development" },
  });
  expect(result.status, result.stderr).toBe(0);
  const code = result.stdout.split("\n")[0] ?? "";

  // Read straight from the file, with no AuthService: constructing one syncs the flag to its own
  // OWNER_EMAIL and would put back exactly what this is checking the CLI did not take away.
  const store = openStore({ path });
  try {
    expect(store.db.prepare("SELECT is_owner FROM users").all()).toEqual([{ is_owner: 1 }]);
  } finally {
    store.close();
  }

  const guest = await withAuth(path, "invite", (auth) =>
    auth.signup({ invite: code, email: "guest@example.test", password: PASSWORD, displayName: "Guest" }, Date.now()),
  );
  expect(guest.ok).toBe(true);
});
