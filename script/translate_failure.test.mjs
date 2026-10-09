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
});

describe("verify_translation.mjs", () => {
  // A static guard rather than a run: the script spends real money, so no test executes it. Thrown
  // errors (error?.message) are real Errors and stay; only translate RESULTS lost .message.
  it("reads no .message off a translate result", () => {
    const source = readFileSync(join(HERE, "verify_translation.mjs"), "utf8");
    expect(source).not.toMatch(/\b(smoke|result|refused)\.message\b/);
  });
});
