import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { describeFailure } from "./translate_failure.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("describeFailure", () => {
  it("names the failure code, the status, and whether a retry can help", () => {
    const text = describeFailure({
      ok: false,
      status: "unavailable",
      reason: "PROVIDER_REJECTED",
      retriable: false,
    });
    expect(text).toContain("PROVIDER_REJECTED");
    expect(text).toContain("unavailable");
    expect(text).toContain("terminal");
  });

  it("says retriable for a failure a retry can fix", () => {
    const text = describeFailure({
      ok: false,
      status: "rate_limited",
      reason: "PROVIDER_RATE_LIMITED",
      retriable: true,
    });
    expect(text).toContain("PROVIDER_RATE_LIMITED");
    expect(text).toContain("retriable");
    expect(text).not.toContain("terminal");
  });

  // The bug this exists for: the script printed result.message, a field a failed translation has
  // not carried since failures became codes, so every failure read "Reason: undefined".
  it("never renders undefined, even for a result missing its fields", () => {
    expect(describeFailure({ ok: false })).not.toContain("undefined");
    expect(describeFailure({ ok: false, status: "unavailable" })).not.toContain("undefined");
  });

  // "terminal" is a claim that a retry cannot help. A result that does not say either way gets
  // no such claim: calling it terminal would send someone away from a retry that might work.
  it("says the retry is unknown when the result does not say", () => {
    for (const value of [{ ok: false }, { ok: false, retriable: "true" }, null, undefined]) {
      const text = describeFailure(value);
      expect(text).toContain("retry unknown");
      expect(text).not.toContain("terminal");
      expect(text).not.toContain("retriable,");
    }
  });
});

describe("verify_translation.mjs", () => {
  // A static guard rather than a run: the script spends real money, so no test executes it. Thrown
  // errors (error?.message) are real Errors and stay; only translate RESULTS lost .message.
  // Comments are stripped first: a comment recording the old bug ("this printed result.message")
  // is history, not the bug, and a guard that fails on it would be deleted rather than understood.
  const code = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads no .message off a translate result", () => {
    const source = code(readFileSync(join(HERE, "verify_translation.mjs"), "utf8"));
    expect(source).not.toMatch(/\b(smoke|result|refused|withGlossary|withoutGlossary)\.message\b/);
  });

  it("does not trip on a comment that names the old bug", () => {
    expect(code("// This printed result.message once.\n/* and smoke.message */\nok();")).not.toMatch(
      /\b(smoke|result)\.message\b/,
    );
    expect(code('const url = "https://example.com"; result.message;')).toMatch(/result\.message/);
  });

  // The glossary check said only "call failed", with no reason, under a script whose job here is
  // to say why a translation failed.
  it("says why the glossary call failed", () => {
    const source = code(readFileSync(join(HERE, "verify_translation.mjs"), "utf8"));
    expect(source).not.toMatch(/"call failed"/);
    expect(source).toMatch(/describeFailure\(withGlossary\)/);
    expect(source).toMatch(/describeFailure\(withoutGlossary\)/);
  });
});
