// Singleton Google Gemini client (`@google/genai`). Reads GEMINI_API_KEY.
// See ADR 0028 — never call Gemini from outside packages/ai.

import { GoogleGenAI } from '@google/genai'

let cached: GoogleGenAI | undefined

export function getGemini(): GoogleGenAI {
  if (cached) return cached
  const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY']
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set. AI calls cannot proceed with provider=gemini. ' +
        'Set GEMINI_API_KEY, or set AI_PROVIDER=openai to use OpenAI. See ADR 0028.',
    )
  }
  cached = new GoogleGenAI({ apiKey })
  return cached
}

// Test-only reset hook. Not exported from the package index.
export function __resetGeminiForTests(): void {
  cached = undefined
}
