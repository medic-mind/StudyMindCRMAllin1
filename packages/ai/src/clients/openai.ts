// Singleton OpenAI client. Reads OPENAI_API_KEY from env.
// See CLAUDE.md Section 18 — never call OpenAI from outside packages/ai.

import OpenAI from 'openai'

let cached: OpenAI | undefined

export function getOpenAI(): OpenAI {
  if (cached) return cached
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. AI calls cannot proceed. See CLAUDE.md Section 22.',
    )
  }
  cached = new OpenAI({ apiKey })
  return cached
}

// Test-only reset hook. Not exported from the package index.
export function __resetOpenAIForTests(): void {
  cached = undefined
}
