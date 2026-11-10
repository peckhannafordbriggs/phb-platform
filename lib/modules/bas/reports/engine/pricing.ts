/**
 * What a model call costs (Reports, Phase 2), metered from the usage counts
 * the API returns - the same approach Cost Intelligence takes with the figure
 * the Agent SDK reports, applied here to the Messages API, which reports
 * tokens and not dollars.
 *
 * Prices are first-party API rates per million tokens, read from the Claude
 * API reference on 2026-11-11. A model not in the table is refused rather
 * than priced at a guess: an unpriced call could not be held to the budget.
 */

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  pricedAt: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, pricedAt: "2026-11-11" },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, pricedAt: "2026-11-11" },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, pricedAt: "2026-11-11" },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costOf(model: string, usage: Usage): number {
  const price = MODEL_PRICES[model];
  if (price === undefined) throw new Error(`No price for model ${model}; add it to MODEL_PRICES.`);
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      usage.cacheWriteTokens * price.cacheWrite) /
    1_000_000
  );
}

/**
 * What a call is likely to cost before it is made, from the prompt's length
 * and a ceiling on the reply. Four characters a token is the rough rule the
 * budget check needs - it decides whether to START a call, and the metered
 * figure replaces it the moment the call returns.
 */
export function estimateCost(model: string, promptChars: number, maxOutputTokens: number): number {
  return costOf(model, {
    inputTokens: Math.ceil(promptChars / 4),
    outputTokens: maxOutputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
}
