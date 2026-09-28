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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAuthSecret } from "../auth/secret.js";
import { AuthService } from "../auth/service.js";
import { loadConfig } from "../config.js";
import { openStore } from "../store/index.js";

const here = dirname(fileURLToPath(import.meta.url));
// src/cli/ or dist/cli/ sits three levels below the repo root either way.
const repoRoot = join(here, "..", "..", "..");

const config = loadConfig(repoRoot);
const store = openStore({ path: config.databasePath });
try {
  // Minting an invite signs nobody in, so the secret only has to exist, not match the server's.
  const auth = new AuthService(store, {
    secret: resolveAuthSecret(config.authSecret).secret,
    signupMode: config.signupMode,
    ownerEmail: config.ownerEmail,
  });
  const invite = auth.createInvite(null, Date.now());
  process.stdout.write(
    `${invite.code}\n` +
      `Single use, expires ${new Date(invite.expiresAt).toISOString()}. ` +
      `Database: ${config.databasePath}\n`,
  );
} finally {
  store.close();
}
