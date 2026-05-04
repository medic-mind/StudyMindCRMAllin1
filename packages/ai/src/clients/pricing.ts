// Per-model OpenAI pricing in USD per 1M tokens. Placeholder values; the
// real numbers should be refreshed quarterly. See CLAUDE.md Section 32.
// Cost estimates from this table are advisory; the source of truth for
// actuals is the OpenAI billing dashboard.

export interface ModelPricing {
  inputUsdPer1M: number
  outputUsdPer1M: number
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  'gpt-4o': { inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  'gpt-4o-mini': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  // Whisper is priced per audio minute; we approximate as $0 token-side.
  'whisper-1': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model]
  if (!p) return 0
  return (
    (inputTokens / 1_000_000) * p.inputUsdPer1M +
    (outputTokens / 1_000_000) * p.outputUsdPer1M
  )
}
