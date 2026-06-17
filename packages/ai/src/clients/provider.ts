// Provider dispatch seam (ADR 0028).
//
// The three public clients (structured / draft / transcribe) keep all their
// cross-cutting logic — budget guardrail, Zod validation, logging, drift
// sampling — and delegate ONLY the network call to this module, which routes to
// OpenAI or Gemini based on packages/ai/src/clients/models.ts.
//
// Structured output strategy differs per provider but the guarantee is the
// same: the caller's Zod schema validates the parsed JSON upstream (fail-closed
// on mismatch). OpenAI uses strict json_schema response_format; Gemini uses
// responseMimeType=application/json plus the schema embedded in the system
// instruction. We deliberately do NOT rely on Gemini's responseSchema (its
// dialect differs from JSON Schema) — the Zod parse is the real contract, so
// this stays portable across providers.

import { anthropicGenerate } from './anthropic'
import { getGemini } from './gemini'
import { type ModelTier, resolveModel } from './models'
import { getOpenAI } from './openai'

export interface GenerateInput {
  tier: ModelTier
  system: string
  user: string
  temperature: number
  /**
   * When set, the call requests JSON output. `schema` is the inline JSON
   * schema (already de-referenced by the caller) and `schemaName` names it.
   */
  json?: { schema: Record<string, unknown>; schemaName: string }
}

export interface GenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
  /** Concrete model id actually used (for logging + cost). */
  model: string
  provider: 'gemini' | 'openai' | 'anthropic'
}

export async function generate(input: GenerateInput): Promise<GenerateResult> {
  const { provider, model } = resolveModel(input.tier)
  if (provider === 'gemini') return generateGemini(model, input)
  if (provider === 'anthropic') return generateAnthropic(model, input)
  return generateOpenAI(model, input)
}

async function generateAnthropic(model: string, input: GenerateInput): Promise<GenerateResult> {
  const result = await anthropicGenerate({
    model,
    system: input.system,
    user: input.user,
    temperature: input.temperature,
    ...(input.json ? { json: input.json } : {}),
  })
  return {
    text: result.text,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model,
    provider: 'anthropic',
  }
}

async function generateOpenAI(model: string, input: GenerateInput): Promise<GenerateResult> {
  const client = getOpenAI()
  const completion = await client.chat.completions.create({
    model,
    temperature: input.temperature,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    ...(input.json
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: input.json.schemaName,
              schema: input.json.schema,
              strict: true,
            },
          },
        }
      : {}),
  })
  return {
    text: completion.choices[0]?.message?.content ?? '',
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
    model,
    provider: 'openai',
  }
}

async function generateGemini(model: string, input: GenerateInput): Promise<GenerateResult> {
  const client = getGemini()

  // For JSON tasks, embed the schema in the system instruction and ask for a
  // JSON mime type. The caller's Zod schema is the authoritative validator.
  const systemInstruction = input.json
    ? `${input.system}\n\nReturn ONLY a single JSON object that conforms to this JSON Schema (no markdown, no prose):\n${JSON.stringify(input.json.schema)}`
    : input.system

  const response = await client.models.generateContent({
    model,
    contents: input.user,
    config: {
      temperature: input.temperature,
      systemInstruction,
      ...(input.json ? { responseMimeType: 'application/json' } : {}),
    },
  })

  const usage = response.usageMetadata
  return {
    text: stripCodeFence(response.text ?? ''),
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
    model,
    provider: 'gemini',
  }
}

/**
 * Gemini occasionally wraps JSON in a ```json fence even with the JSON mime
 * type. Strip a single leading/trailing fence so JSON.parse succeeds. No-op
 * for plain prose (drafts), which never start with a fence we care about.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return text
  return trimmed
    .replace(/^```[a-zA-Z]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
}
