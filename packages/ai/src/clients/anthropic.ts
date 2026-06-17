// Anthropic (Claude) client for the AI provider seam (ADR 0028).
//
// Fetch-based via safeFetch (no SDK dependency — mirrors the Slack/Zoom
// clients), so adding Claude needs no new package. Reads ANTHROPIC_API_KEY.
// Never call Anthropic from outside packages/ai.
//
// Structured output: Claude has no `response_format: json_schema`, so we force a
// single tool call whose `input_schema` is the caller's JSON Schema and read the
// tool input back as the JSON string. The caller's Zod parse remains the real
// contract (same guarantee as the OpenAI/Gemini paths).

import { safeFetch } from '@studymind/core/observability/safe-fetch'

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicGenerateInput {
  model: string
  system: string
  user: string
  temperature: number
  json?: { schema: Record<string, unknown>; schemaName: string }
  maxTokens?: number
}

export interface AnthropicGenerateResult {
  text: string
  inputTokens: number
  outputTokens: number
}

export function getAnthropicKey(): string {
  const key = process.env['ANTHROPIC_API_KEY']
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. AI calls cannot proceed with provider=anthropic. ' +
        'Set ANTHROPIC_API_KEY, or set AI_PROVIDER=gemini / openai. See ADR 0028.',
    )
  }
  return key
}

interface AnthropicContentBlock {
  type: string
  text?: string
  input?: unknown
}

interface AnthropicResponse {
  type?: string
  content?: AnthropicContentBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export async function anthropicGenerate(
  input: AnthropicGenerateInput,
): Promise<AnthropicGenerateResult> {
  const key = getAnthropicKey()

  const body: Record<string, unknown> = {
    model: input.model,
    max_tokens: input.maxTokens ?? 4096,
    temperature: input.temperature,
    system: input.system,
    messages: [{ role: 'user', content: input.user }],
  }
  if (input.json) {
    // Force the single tool call; its `input` IS the structured result.
    body['tools'] = [
      {
        name: input.json.schemaName,
        description: `Return the result strictly as ${input.json.schemaName}.`,
        input_schema: input.json.schema,
      },
    ]
    body['tool_choice'] = { type: 'tool', name: input.json.schemaName }
  }

  const res = await safeFetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const parsed = (text ? JSON.parse(text) : {}) as AnthropicResponse
  if (!res.ok || parsed.type === 'error') {
    throw new Error(`Anthropic API error: ${parsed.error?.message ?? `http_${res.status}`}`)
  }

  const blocks = parsed.content ?? []
  let out = ''
  if (input.json) {
    const tool = blocks.find((b) => b.type === 'tool_use')
    out = tool ? JSON.stringify(tool.input ?? {}) : ''
  } else {
    out = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  }

  return {
    text: out,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
  }
}
