// The production boot guard for the database, mirroring the ephemeral ledger guard in index.ts.
//
// A database on the image layer is lost on every redeploy: every account, every refresh token,
// every invite, gone without an error, and the first sign would be users who can no longer sign
// in. The same device comparison the ledger guard uses decides it, with the same caveat: a proxy,
// not a proof, which is why ALLOW_EPHEMERAL_DATA exists.

import { statSync } from "node:fs";
import { dirname } from "node:path";

type Stat = (path: string) => { dev: number | bigint };

/**
 * Is the data directory on the same device as the filesystem root?
 *
 * A directory that does not exist yet is judged by its nearest existing ancestor, because that is
 * the device the store will create it on. The ledger guard can say "cannot tell" for a missing
 * directory since the image always ships out/; data/ is created at first open, so the question
 * has a real answer before it exists.
 */
export function isEphemeralDataDir(dir: string, stat: Stat = statSync): boolean {
  let rootDev: number | bigint;
  try {
    rootDev = stat("/").dev;
  } catch {
    return false;
  }
  let current = dir;
  for (;;) {
    try {
      return stat(current).dev === rootDev;
    } catch {
      const parent = dirname(current);
      // Cannot tell. Say no rather than blocking a boot over a question that could not be asked.
      if (parent === current) return false;
      current = parent;
    }
  }
}

/** The refusal message when production must not start, or null when it may. */
export function ephemeralDataRefusal(input: {
  isProduction: boolean;
  ephemeral: boolean;
  allow: string | undefined;
}): string | null {
  if (!input.isProduction || !input.ephemeral) return null;
  if ((input.allow ?? "").trim() !== "") return null;
  return (
    "refusing to start: the database is on the image layer, not a mount, so a redeploy would " +
    "silently delete every account and token in it. Mount a volume over the data directory " +
    "(DATA_DIR), or set ALLOW_EPHEMERAL_DATA=1 if this host genuinely keeps it on the root device."
  );
}
