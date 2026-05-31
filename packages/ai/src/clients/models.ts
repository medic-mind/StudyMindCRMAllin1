// AI provider + model resolution (ADR 0028).
//
// All AI on the site runs through packages/ai. This module is the single place
// that decides WHICH provider and model a call uses, so the rest of the package
// (and every call site) stays provider-agnostic.
//
// Defaults: Gemini is preferred once GEMINI_API_KEY is set; both tiers default
// to Gemini 2.5 Flash ("flash for most"), each independently overridable by env
// so you can promote the quality tier to Pro without touching code. Set
// AI_PROVIDER explicitly to pin a provider (e.g. AI_PROVIDER=openai to revert).

export type AiProvider = 'gemini' | 'openai'

/**
 * Two quality tiers used across the app. Call sites still pass the legacy
 * OpenAI model strings (`gpt-4o` / `gpt-4o-mini`); those are treated as tier
 * aliases so no call site had to change when we added Gemini.
 */
export type ModelTier = 'mini' | 'standard'

/** Map a legacy model literal to a tier. `gpt-4o` → standard, else mini. */
export function tierOf(legacyModel: string | undefined): ModelTier {
  return legacyModel === 'gpt-4o' ? 'standard' : 'mini'
}

const DEFAULTS = {
  geminiMini: 'gemini-2.5-flash',
  geminiStandard: 'gemini-2.5-flash', // "flash for most"; override to gemini-2.5-pro
  geminiTranscribe: 'gemini-2.5-flash',
  openaiMini: 'gpt-4o-mini',
  openaiStandard: 'gpt-4o',
  openaiTranscribe: 'whisper-1',
} as const

/**
 * Which provider to use. An explicit AI_PROVIDER wins (and fails closed in the
 * client if its key is missing). Otherwise prefer Gemini when its key is
 * present so adding GEMINI_API_KEY flips the site to Gemini without a code
 * change, and a deploy that has only the OpenAI key keeps working.
 */
export function resolveProvider(): AiProvider {
  const explicit = process.env['AI_PROVIDER']?.trim().toLowerCase()
  if (explicit === 'openai' || explicit === 'gemini') return explicit
  if (process.env['GEMINI_API_KEY']) return 'gemini'
  return 'openai'
}

export interface ResolvedModel {
  provider: AiProvider
  model: string
}

function envModel(name: string, fallback: string): string {
  const v = process.env[name]?.trim()
  return v && v.length > 0 ? v : fallback
}

/** Resolve a chat/structured model for a tier under the active provider. */
export function resolveModel(tier: ModelTier): ResolvedModel {
  const provider = resolveProvider()
  if (provider === 'gemini') {
    return {
      provider,
      model:
        tier === 'standard'
          ? envModel('GEMINI_MODEL_STANDARD', DEFAULTS.geminiStandard)
          : envModel('GEMINI_MODEL_MINI', DEFAULTS.geminiMini),
    }
  }
  return {
    provider,
    model:
      tier === 'standard'
        ? envModel('OPENAI_MODEL_STANDARD', DEFAULTS.openaiStandard)
        : envModel('OPENAI_MODEL_MINI', DEFAULTS.openaiMini),
  }
}

/** Resolve the transcription model under the active provider. */
export function resolveTranscriptionModel(): ResolvedModel {
  const provider = resolveProvider()
  if (provider === 'gemini') {
    return { provider, model: envModel('GEMINI_MODEL_TRANSCRIBE', DEFAULTS.geminiTranscribe) }
  }
  return { provider, model: envModel('OPENAI_MODEL_TRANSCRIBE', DEFAULTS.openaiTranscribe) }
}
