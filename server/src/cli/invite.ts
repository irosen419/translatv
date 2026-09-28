// `npm run invite`: mint one single use invite against the database directly, and print it.
//
// For the owner, from a shell on the machine that holds the database. It is how the very first
// account gets made on an invite only server (nobody is signed in yet to ask /api/invites), and
// it works whether or not OWNER_EMAIL is set.
//
// The code is printed to stdout and nowhere else. It is deliberately NOT passed to the logger
// (which would withhold it anyway: `invite` is a forbidden key) and not written to any file. Only
// its hash is stored, so a lost code is replaced by running this again.
//
// In the container, where there is no tsx: `node server/dist/cli/invite.js`.
//
// It mints through mintInvite, NOT through an AuthService. Constructing an AuthService makes the
// owner flag agree with OWNER_EMAIL, and this runs from whatever shell the owner has open, so it
// demoted the live owner whenever that shell had no OWNER_EMAIL. Ownership is the server's to set
// at boot. Minting also needs no AUTH_SECRET: a code is random, and only its hash is stored.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mintInvite } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { openStore } from "../store/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/cli/ or dist/cli/ sits three levels below the repo root either way.
const repoRoot = join(here, "..", "..", "..");

const config = loadConfig(repoRoot);
const store = openStore({ path: config.databasePath });
try {
  const invite = mintInvite(store, null, Date.now());
  process.stdout.write(
    `${invite.code}\n` +
      `Single use, expires ${new Date(invite.expiresAt).toISOString()}. ` +
      `Database: ${config.databasePath}\n`,
  );
} finally {
  store.close();
}
