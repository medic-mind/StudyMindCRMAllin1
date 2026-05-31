import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resolveModel, resolveProvider, resolveTranscriptionModel, tierOf } from './models'

// Snapshot + restore the env keys this module reads, so tests are isolated.
const KEYS = [
  'AI_PROVIDER',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_MODEL_MINI',
  'GEMINI_MODEL_STANDARD',
  'GEMINI_MODEL_TRANSCRIBE',
  'OPENAI_MODEL_MINI',
  'OPENAI_MODEL_STANDARD',
  'OPENAI_MODEL_TRANSCRIBE',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('tierOf', () => {
  it('maps gpt-4o to the standard tier and everything else to mini', () => {
    expect(tierOf('gpt-4o')).toBe('standard')
    expect(tierOf('gpt-4o-mini')).toBe('mini')
    expect(tierOf(undefined)).toBe('mini')
  })
})

describe('resolveProvider', () => {
  it('prefers Gemini once GEMINI_API_KEY is set (no code change to flip)', () => {
    process.env['GEMINI_API_KEY'] = 'g'
    expect(resolveProvider()).toBe('gemini')
  })

  it('falls back to OpenAI when only OPENAI_API_KEY is present', () => {
    process.env['OPENAI_API_KEY'] = 'o'
    expect(resolveProvider()).toBe('openai')
  })

  it('honours an explicit AI_PROVIDER override regardless of keys', () => {
    process.env['GEMINI_API_KEY'] = 'g'
    process.env['AI_PROVIDER'] = 'openai'
    expect(resolveProvider()).toBe('openai')
  })

  it('defaults to OpenAI when nothing is configured', () => {
    expect(resolveProvider()).toBe('openai')
  })
})

describe('resolveModel — Gemini Flash-by-default, overridable', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'g'
  })

  it('uses Flash for both tiers by default ("flash for most")', () => {
    expect(resolveModel('mini')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' })
    expect(resolveModel('standard')).toEqual({ provider: 'gemini', model: 'gemini-2.5-flash' })
  })

  it('lets you promote the standard tier to Pro via env without code change', () => {
    process.env['GEMINI_MODEL_STANDARD'] = 'gemini-2.5-pro'
    expect(resolveModel('standard').model).toBe('gemini-2.5-pro')
    // mini tier untouched
    expect(resolveModel('mini').model).toBe('gemini-2.5-flash')
  })
})

describe('resolveModel — OpenAI fallback tiers', () => {
  beforeEach(() => {
    process.env['AI_PROVIDER'] = 'openai'
  })

  it('maps tiers to the legacy OpenAI models', () => {
    expect(resolveModel('mini')).toEqual({ provider: 'openai', model: 'gpt-4o-mini' })
    expect(resolveModel('standard')).toEqual({ provider: 'openai', model: 'gpt-4o' })
  })

  it('honours per-tier model overrides', () => {
    process.env['OPENAI_MODEL_STANDARD'] = 'gpt-4o-2024-11-20'
    expect(resolveModel('standard').model).toBe('gpt-4o-2024-11-20')
  })
})

describe('resolveTranscriptionModel', () => {
  it('uses Gemini multimodal when Gemini is active', () => {
    process.env['GEMINI_API_KEY'] = 'g'
    expect(resolveTranscriptionModel()).toEqual({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
    })
  })

  it('uses Whisper when OpenAI is active', () => {
    process.env['AI_PROVIDER'] = 'openai'
    expect(resolveTranscriptionModel()).toEqual({ provider: 'openai', model: 'whisper-1' })
  })
})
