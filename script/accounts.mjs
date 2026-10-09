// Accounts for the scripts that drive the real UI (e2e.mjs, shots.mjs, latency.mjs).
//
// Every call needs a signed in account since M4. These harnesses start their own server with
// open signup and a throwaway database, make accounts through the real API, and hand a browser a
// context that starts signed in: the refresh token is placed in localStorage under the key the
// client reads (client/src/lib/session.ts), so the first page load restores the session exactly as
// a returning visitor's would.

import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** The environment a harness server needs for accounts, beside its own settings. */
export function accountsEnv(root) {
  return {
    // Open signup, so the harness can make the accounts it needs. Invite only signup, the
    // production default, gets a server of its own in the last sections of e2e.mjs, and the
    // rules behind it are tested in server/src/auth/.
    SIGNUP_MODE: "open",
    // A throwaway database beside the throwaway ledger, never the repo's data/.
    DATA_DIR: join(root, "data"),
    // Generated per run, never written down. Set only to keep the boot log free of the
    // "generated a random secret" warning; any value works.
    AUTH_SECRET: randomBytes(32).toString("hex"),
  };
}

/** A password for a harness's accounts. Generated per run, never written down. */
export const PASSWORD = randomBytes(12).toString("hex");

/** The email a harness account named `name` gets. */
export function emailFor(name) {
  return `${name.toLowerCase()}@harness.test`;
}

/** Make an account through the API and hand back its refresh token. */
export async function signUpViaApi(base, name) {
  const response = await fetch(`${base}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: emailFor(name), password: PASSWORD, displayName: name }),
  });
  if (response.status !== 201) throw new Error(`signup for ${name} answered ${response.status}`);
  return (await response.json()).refreshToken;
}

/** A browser context that starts signed in as a fresh account called `name`. */
export async function signedInContext(browser, base, name, options = {}) {
  const refreshToken = await signUpViaApi(base, name);
  return browser.newContext({
    ...options,
    storageState: {
      cookies: [],
      origins: [{ origin: base, localStorage: [{ name: "translatv.refresh", value: refreshToken }] }],
    },
  });
}
