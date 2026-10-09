// How a failed translation reads in a terminal.
//
// A failed TranslateResult carries a wire code (`reason`), a `status` and `retriable`: the sentence a
// person reads lives in the client's copy files, per language, so no prose crosses the wire. The
// verify script still printed `result.message`, from before that change, so every failure it hit
// read "Reason: undefined" at exactly the moment someone needed to know why.
//
// Plain .mjs with no TypeScript imports, so the script/ vitest project can cover it. The verify
// script itself spends real money and is never run by a test.

export function describeFailure(result) {
  const reason = typeof result?.reason === "string" ? result.reason : "no failure code";
  const status = typeof result?.status === "string" ? result.status : "unknown status";
  const retry = result?.retriable === true ? "retriable" : "terminal";
  return `${reason} (${status}, ${retry})`;
}
