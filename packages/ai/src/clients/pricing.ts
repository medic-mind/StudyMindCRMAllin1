// Per-model OpenAI pricing in USD per 1M tokens. Placeholder values; the
// real numbers should be refreshed quarterly. See CLAUDE.md Section 32.
// Cost estimates from this table are advisory; the source of truth for
// actuals is the OpenAI billing dashboard.

export interface ModelPricing {
  inputUsdPer1M: number
  outputUsdPer1M: number
}

export const PRICING: Readonly<Record<string, ModelPricing>> = {
  // OpenAI
  'gpt-4o': { inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  'gpt-4o-mini': { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  // Whisper is priced per audio minute; we approximate as $0 token-side.
  'whisper-1': { inputUsdPer1M: 0, outputUsdPer1M: 0 },
  // Gemini (ADR 0028). Advisory placeholders; refresh quarterly against the
  // Google AI pricing page. Flash is the default tier across the app.
  'gemini-2.5-flash': { inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  'gemini-2.5-flash-lite': { inputUsdPer1M: 0.1, outputUsdPer1M: 0.4 },
  'gemini-2.5-pro': { inputUsdPer1M: 1.25, outputUsdPer1M: 10 },
  'gemini-1.5-flash': { inputUsdPer1M: 0.075, outputUsdPer1M: 0.3 },
  'gemini-1.5-pro': { inputUsdPer1M: 1.25, outputUsdPer1M: 5 },
  // Anthropic (Claude) — ADR 0028. Advisory placeholders; refresh quarterly
  // against the Anthropic pricing page.
  'claude-haiku-4-5-20251001': { inputUsdPer1M: 1, outputUsdPer1M: 5 },
  'claude-sonnet-4-6': { inputUsdPer1M: 3, outputUsdPer1M: 15 },
  'claude-opus-4-8': { inputUsdPer1M: 15, outputUsdPer1M: 75 },
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model]
  if (!p) return 0
  return (inputTokens / 1_000_000) * p.inputUsdPer1M + (outputTokens / 1_000_000) * p.outputUsdPer1M
}
