// Wire codes to copy keys.
//
// Two one line functions, and they are here rather than inline at the call sites for one
// property: the return type is CopyKey, so a code the server can send and the copy files have no
// sentence for does not compile. Adding "LEDGER_UNWRITABLE" to the protocol and forgetting
// "failure.LEDGER_UNWRITABLE" in en.json is a type error at this line, which is a much better
// place to learn it than a call where somebody is watching their subtitles stop.

import type { ErrorCode, TranslationFailureCode } from "@translatv/shared";

import type { CopyKey } from "./copy.js";

export function errorCopyKey(code: ErrorCode): CopyKey {
  return `error.${code}`;
}

export function failureCopyKey(code: TranslationFailureCode): CopyKey {
  return `failure.${code}`;
}
