// Model prices, in US dollars per million tokens.
//
// ONLY prices documented with a citable source appear here. An unpriced model resolves to
// null, which callers render as "cost unknown", and that is the correct outcome: an omitted
// price is honest, a guessed one is a lie attached to a spend figure. Never interpolate a
// price from a neighbouring tier, and never add one you cannot point at a source for.
//
// Carried over from awws, where the equivalent rule exists because a backend with no recorded
// unit cost got a plausible looking number attached to it and the book's total was wrong for
// weeks before anyone noticed.

export interface Rates {
  /** US dollars per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** US dollars per million output tokens. */
  readonly outputUsdPerMTok: number;
}

export interface ModelPrice extends Rates {
  /** Where this price came from. Required: a price with no source does not belong here. */
  readonly source: string;
  /**
   * A second, higher rate for a long prompt, when the pricing page gives one.
   *
   * It applies to the WHOLE call, input and output both, once the call's input tokens are MORE
   * than aboveInputTokens: a prompt of exactly that many is still billed at the base rate. Only
   * modelled where it is documented; a model without one is billed at its base rate at any length.
   */
  readonly longPrompt?: Rates & { readonly aboveInputTokens: number };
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic published pricing for Claude Haiku 4.5.
  "claude-haiku-4-5": Object.freeze({
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    source: "Anthropic pricing page, Claude Haiku 4.5, $1/MTok in and $5/MTok out",
  }),
  // Claude Haiku 5.5, read off the pricing page on 2026-11-11. The page prices it in two tiers by
  // prompt length, and both are here because a call past the line is billed five times higher on
  // everything it used: pricing it at the short rate would under-log it, the harmful direction.
  // Thinking tokens are billed as output and are already inside usage.output_tokens, so they need
  // no rate of their own.
  "claude-haiku-5-5": Object.freeze({
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    longPrompt: Object.freeze({ aboveInputTokens: 100_000, inputUsdPerMTok: 0.5, outputUsdPerMTok: 2.5 }),
    source:
      "https://platform.claude.com/docs/en/about-claude/pricing, Claude Haiku 5.5, $0.10/MTok in " +
      "and $0.50/MTok out for prompts up to 100,000 tokens, $0.50 and $2.50 over 100,000",
  }),
  // Claude Sonnet 5.5, read off the same page on 2026-11-11. Here as the blind test's judge
  // (src/eval/blind), not as a translation model.
  "claude-sonnet-5-5": Object.freeze({
    inputUsdPerMTok: 2.0,
    outputUsdPerMTok: 10.0,
    source: "https://platform.claude.com/docs/en/about-claude/pricing, Claude Sonnet 5.5, $2/MTok in and $10/MTok out",
  }),
});

/** The default translation model. Kept here so the price and the choice cannot drift apart. */
export const DEFAULT_MODEL = "claude-haiku-4-5";

/** The price for a model, or null when this repo has no documented price for it. */
export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null;
}

/**
 * The rates one call is billed at, given how many input tokens it had, or null when the model has
 * no documented price. The long prompt rate replaces the base rate for the whole call once the
 * input is over its threshold.
 */
export function ratesFor(model: string, inputTokens: number): Rates | null {
  const price = priceFor(model);
  if (price === null) return null;
  const tier = price.longPrompt !== undefined && inputTokens > price.longPrompt.aboveInputTokens ? price.longPrompt : price;
  return { inputUsdPerMTok: tier.inputUsdPerMTok, outputUsdPerMTok: tier.outputUsdPerMTok };
}

/**
 * Cost in US dollars for a call, or null when the model has no documented price.
 *
 * Null rather than 0 is deliberate and load bearing: a zero would be summed into a total as
 * though the call were free, silently understating spend against a cap. Null propagates into
 * the ledger's `unparsed_rows` count instead, so the total is presented as a floor.
 */
export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = ratesFor(model, inputTokens);
  if (price === null) return null;

  const dollars =
    (inputTokens / 1_000_000) * price.inputUsdPerMTok +
    (outputTokens / 1_000_000) * price.outputUsdPerMTok;
  return roundMoney(dollars);
}

/**
 * Six decimal places, matching spend_log.py and the dashboard's Ruby SpendLedger.
 *
 * All three round identically on purpose, so a figure read off the cockpit and one printed by
 * the CLI cannot differ in the tail and send someone hunting a discrepancy that is really
 * just floating point noise.
 */
export const MONEY_PRECISION = 6;

export function roundMoney(amount: number): number {
  const factor = 10 ** MONEY_PRECISION;
  return Math.round(amount * factor) / factor;
}
