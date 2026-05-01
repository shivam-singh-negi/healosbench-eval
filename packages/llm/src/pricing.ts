/**
 * Per-million-token prices in USD. Update if Anthropic moves pricing.
 * Cache writes are 1.25x base input; cache reads are 0.1x base input.
 * https://docs.claude.com/en/docs/build-with-claude/prompt-caching#pricing
 */
const PRICES_PER_MTOK: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
  "claude-opus-4-7": { input: 15.0, output: 75.0 },
  // Gemini pricing (free tier shown as 0 for our cost accounting; paid prices
  // would replace these values).
  "gemini-2.5-flash": { input: 0, output: 0 },
  "gemini-2.0-flash": { input: 0, output: 0 },
  "gemini-1.5-flash": { input: 0, output: 0 },
};

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export function priceUsage(model: string, u: UsageBreakdown): number {
  const p = PRICES_PER_MTOK[model] ?? PRICES_PER_MTOK["claude-haiku-4-5-20251001"]!;
  const base = p.input / 1_000_000;
  const out = p.output / 1_000_000;
  return (
    u.inputTokens * base +
    u.cacheCreationInputTokens * base * 1.25 +
    u.cacheReadInputTokens * base * 0.1 +
    u.outputTokens * out
  );
}
