// Room code generation and normalization.
//
// Crockford base32, 8 characters, from crypto.randomBytes. The alphabet deliberately excludes
// I, L, O, and U: people READ THESE ALOUD to a friend, and I/1, L/1, O/0 are the pairs that get
// misheard. U is excluded by Crockford to avoid accidental obscenities.
//
// Entropy: 32^8 is about 1.1e12, or 40 bits. Combined with the join rate limit (10 attempts per
// minute per IP), the expected time to a single successful guess against 1,000 live rooms is
// measured in centuries. That is the whole security model for room access, and it is adequate
// because a room holds no persistent data and dies when it empties.

import { randomBytes, randomInt } from "node:crypto";

/** Crockford base32, excluding I, L, O, U. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

export function generateCode(): string {
  // randomInt over the alphabet rather than masking randomBytes, because 256 is not a multiple
  // of 32... it is, but taking bytes % 32 would still be correct only because of that. Using
  // randomInt states the uniformity requirement instead of relying on the reader noticing it.
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return code;
}

/**
 * Normalize a code a human typed or read aloud.
 *
 * Applied on BOTH generation validation and lookup, so a code entered as "abc-defgh" with an
 * O for a zero resolves to the same room as the canonical form. Without this, the excluded
 * alphabet only helps the person reading the code out, not the person typing it in.
 */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/U/g, "V");
}

export function isValidCode(input: string): boolean {
  const normalized = normalizeCode(input);
  return (
    normalized.length === CODE_LENGTH &&
    [...normalized].every((char) => ALPHABET.includes(char))
  );
}

/** A 128 bit resume token. Only its sha256 is ever stored server side. */
export function generateResumeToken(): string {
  return randomBytes(16).toString("base64url");
}
