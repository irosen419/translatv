// Password hashing: scrypt from node:crypto with a per user random salt.
//
// The stored value is SELF DESCRIBING: "scrypt$N=16384,r=8,p=1$<salt>$<hash>". Carrying the
// parameters in the row is what lets them be raised later without invalidating every account: a
// row hashed under the old cost still names the cost it was hashed under, and verifies with it.
//
// Async on purpose. scrypt at these parameters costs tens of milliseconds, and the synchronous
// form would stall every WebSocket on the server for that long on each sign in. The async form
// runs on libuv's thread pool.
//
// Nothing here throws on a bad stored value. A row this code cannot read is a failed login, not a
// crashed request.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@translatv/shared";

// The policy numbers live in shared/src/auth.ts so the client can explain them in the reader's
// language; this is where they are enforced.
export { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH };

const PARAMS = { N: 16_384, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

/**
 * The most memory one verification may ask for.
 *
 * scrypt needs about 128 * N * r bytes. A row claiming N=2^30 would ask for a terabyte; this is
 * the line between "a cost somebody chose" and "a value that would take the process down".
 */
const MAX_MEMORY_BYTES = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function memoryFor(N: number, r: number): number {
  return 128 * N * r + 1024 * 1024;
}

export function passwordIsAcceptable(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: memoryFor(PARAMS.N, PARAMS.r),
  });
  return `scrypt$N=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return null;
  const params = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(parts[1] ?? "");
  if (!params) return null;
  const [N, r, p] = [Number(params[1]), Number(params[2]), Number(params[3])];
  // N must be a power of two above 1, which is scrypt's own rule; checked here so a bad row is a
  // false rather than a thrown error.
  if (!Number.isSafeInteger(N) || N < 2 || (N & (N - 1)) !== 0) return null;
  if (!Number.isSafeInteger(r) || r < 1 || !Number.isSafeInteger(p) || p < 1 || p > 16) return null;
  if (memoryFor(N, r) > MAX_MEMORY_BYTES) return null;
  const salt = Buffer.from(parts[2] ?? "", "base64url");
  const key = Buffer.from(parts[3] ?? "", "base64url");
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

/**
 * Does this password produce the stored hash?
 *
 * The comparison is timingSafeEqual over two buffers of the SAME length (the derived key is asked
 * for at the stored key's length), so it cannot throw and cannot leak how much matched.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  try {
    const candidate = await scrypt(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: memoryFor(parsed.N, parsed.r),
    });
    return timingSafeEqual(candidate, parsed.key);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random password, made once per process.
 *
 * A login for an email with no account still runs one full verification against this, so the
 * time a refusal takes does not say whether the account exists. Without it "no such user" would
 * answer in a microsecond and "wrong password" in tens of milliseconds, and the difference is the
 * existence oracle the uniform error code exists to deny.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}
