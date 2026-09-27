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

export interface ModelPrice {
  /** US dollars per million input tokens. */
  readonly inputUsdPerMTok: number;
  /** US dollars per million output tokens. */
  readonly outputUsdPerMTok: number;
  /** Where this price came from. Required: a price with no source does not belong here. */
  readonly source: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // Anthropic published pricing for Claude Haiku 4.5.
  "claude-haiku-4-5": Object.freeze({
    inputUsdPerMTok: 1.0,
    outputUsdPerMTok: 5.0,
    source: "Anthropic pricing page, Claude Haiku 4.5, $1/MTok in and $5/MTok out",
  }),
});

/** The default translation model. Kept here so the price and the choice cannot drift apart. */
export const DEFAULT_MODEL = "claude-haiku-4-5";

/** The price for a model, or null when this repo has no documented price for it. */
export function priceFor(model: string): ModelPrice | null {
  return MODEL_PRICES[model] ?? null;
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
  const price = priceFor(model);
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
