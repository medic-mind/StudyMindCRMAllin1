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

export type AiProvider = 'gemini' | 'openai' | 'anthropic'

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
  // Anthropic (Claude). Env-overridable so a key with different model access can
  // adjust without code (ANTHROPIC_MODEL_MINI / ANTHROPIC_MODEL_STANDARD).
  anthropicMini: 'claude-haiku-4-5-20251001',
  anthropicStandard: 'claude-sonnet-4-6',
} as const

/**
 * Which provider to use. An explicit AI_PROVIDER wins (and fails closed in the
 * client if its key is missing). Otherwise prefer Gemini when its key is
 * present so adding GEMINI_API_KEY flips the site to Gemini without a code
 * change, and a deploy that has only the OpenAI key keeps working.
 */
export function resolveProvider(): AiProvider {
  const explicit = process.env['AI_PROVIDER']?.trim().toLowerCase()
  if (explicit === 'openai' || explicit === 'gemini' || explicit === 'anthropic') return explicit
  // Auto-select by which key is present, so dropping a key into the environment
  // flips the provider with no code change. Gemini stays the documented default
  // when its key is set; otherwise a Claude key (the common case here) wins over
  // the OpenAI fallback.
  if (process.env['GEMINI_API_KEY']) return 'gemini'
  if (process.env['ANTHROPIC_API_KEY']) return 'anthropic'
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
  if (provider === 'anthropic') {
    return {
      provider,
      model:
        tier === 'standard'
          ? envModel('ANTHROPIC_MODEL_STANDARD', DEFAULTS.anthropicStandard)
          : envModel('ANTHROPIC_MODEL_MINI', DEFAULTS.anthropicMini),
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

/**
 * Resolve the transcription model. Claude has no audio transcription, so when
 * Anthropic is the active provider we fall back to a transcription-capable one:
 * Gemini if its key is present, else OpenAI Whisper. (Aircall AI Assist is the
 * primary transcript source; this is only the fallback path — CLAUDE.md §10.)
 */
export function resolveTranscriptionModel(): ResolvedModel {
  const provider = resolveProvider()
  if (provider === 'gemini') {
    return { provider, model: envModel('GEMINI_MODEL_TRANSCRIBE', DEFAULTS.geminiTranscribe) }
  }
  if (provider === 'anthropic') {
    if (process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY']) {
      return {
        provider: 'gemini',
        model: envModel('GEMINI_MODEL_TRANSCRIBE', DEFAULTS.geminiTranscribe),
      }
    }
    return {
      provider: 'openai',
      model: envModel('OPENAI_MODEL_TRANSCRIBE', DEFAULTS.openaiTranscribe),
    }
  }
  return { provider, model: envModel('OPENAI_MODEL_TRANSCRIBE', DEFAULTS.openaiTranscribe) }
}
