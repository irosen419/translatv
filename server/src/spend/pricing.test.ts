// The price table: which models it knows, and which rate a given call is billed at.
//
// The long prompt tier is the one thing here that is not a single multiplication. Claude Haiku 5.5
// is billed at one rate for a prompt of up to 100,000 input tokens and at five times that for a
// longer one, on the WHOLE call, not just the tokens past the line. Pricing such a call at the
// short rate under-logs it by a factor of five, which is the harmful direction.

import { describe, expect, it } from "vitest";
import { costUsd, DEFAULT_MODEL, priceFor, ratesFor } from "./pricing.js";

describe("the documented models", () => {
  it("keeps Haiku 4.5 at $1 in and $5 out, and keeps it the default", () => {
    // The model switch is the owner's decision after the blind test, not a side effect of it.
    expect(DEFAULT_MODEL).toBe("claude-haiku-4-5");
    expect(ratesFor("claude-haiku-4-5", 800)).toEqual({ inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
    expect(costUsd("claude-haiku-4-5", 800, 30)).toBe(0.00095);
  });

  it("prices Haiku 5.5 at $0.10 in and $0.50 out for an ordinary prompt", () => {
    expect(ratesFor("claude-haiku-5-5", 800)).toEqual({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    expect(costUsd("claude-haiku-5-5", 100_000, 1_000_000)).toBe(0.51);
  });

  it("prices Sonnet 5.5 at $2 in and $10 out", () => {
    expect(ratesFor("claude-sonnet-5-5", 2000)).toEqual({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 });
    expect(costUsd("claude-sonnet-5-5", 2000, 300)).toBe(0.007);
  });

  it("cites a source for every price, the pricing page for the new ones", () => {
    for (const model of ["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5"]) {
      expect(priceFor(model)?.source).toBeTruthy();
    }
    expect(priceFor("claude-haiku-5-5")?.source).toContain("https://platform.claude.com/docs/en/about-claude/pricing");
    expect(priceFor("claude-sonnet-5-5")?.source).toContain("https://platform.claude.com/docs/en/about-claude/pricing");
  });

  it("knows nothing it was not told: no neighbouring model inherits a price", () => {
    expect(priceFor("claude-sonnet-5")).toBeNull();
    expect(costUsd("claude-haiku-5", 100, 100)).toBeNull();
    expect(ratesFor("claude-haiku-5", 100)).toBeNull();
  });
});

describe("the Haiku 5.5 long prompt tier", () => {
  it("bills a prompt of exactly 100,000 tokens at the short rate", () => {
    expect(ratesFor("claude-haiku-5-5", 100_000)).toEqual({ inputUsdPerMTok: 0.1, outputUsdPerMTok: 0.5 });
    expect(costUsd("claude-haiku-5-5", 100_000, 1000)).toBe(0.0105);
  });

  it("bills a prompt over 100,000 tokens at the long rate, input AND output, on the whole call", () => {
    expect(ratesFor("claude-haiku-5-5", 100_001)).toEqual({ inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 });
    // 100,001 x $0.50 + 1,000 x $2.50, per million, is $0.0525005: never the $0.0105 the short
    // rate would say.
    expect(costUsd("claude-haiku-5-5", 100_001, 1000)).toBe(0.052501);
  });

  it("has no long tier for a model whose page gives none", () => {
    expect(ratesFor("claude-haiku-4-5", 150_000)).toEqual({ inputUsdPerMTok: 1, outputUsdPerMTok: 5 });
  });
});
