// Structured-output OpenAI client wrapper. See CLAUDE.md Section 18.1.
// Used for classification / extraction tasks via response_format=json_schema.
//
// Responsibilities:
// - Enforce the budget guardrail BEFORE any network call.
// - Send the prompt with strict structured outputs.
// - Validate the response against the caller's Zod schema and fail closed
//   on mismatch with BusinessError('AI_OUTPUT_INVALID').
// - Log model, prompt version, tokens, latency, and estimated cost.
// - Record usage so subsequent budget checks see today's spend.

import { BusinessError, logger } from '@studymind/core'
import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

import { type AiTaskCategory, checkBudget, recordUsage } from '../budget'
import { sampleForDrift } from '../drift'
import { assertContactNotRestricted } from './restricted-guard'
import { getOpenAI } from './openai'
import { estimateCostUsd } from './pricing'

export type StructuredModel = 'gpt-4o' | 'gpt-4o-mini'

export interface RunStructuredInput<T> {
  task: AiTaskCategory
  promptVersion: string
  schema: z.ZodType<T>
  schemaName?: string
  system: string
  user: string
  model?: StructuredModel
  temperature?: number
  /** Free-form context for log correlation (request id, family id, etc). */
  ctx?: Record<string, unknown>
  /** When provided, the call aborts if this contact is restricted_access. */
  contactId?: string
}

export async function runStructured<T>(input: RunStructuredInput<T>): Promise<T> {
  const {
    task,
    promptVersion,
    schema,
    schemaName = task,
    system,
    user,
    model = 'gpt-4o-mini',
    temperature = 0.2,
    ctx,
    contactId,
  } = input

  await assertContactNotRestricted(contactId)

  const budget = checkBudget(task)
  if (!budget.allowed) {
    throw new BusinessError(
      'AI_BUDGET_EXCEEDED',
      `Daily AI budget exhausted for task ${task}.`,
      { task, mode: budget.mode },
    )
  }
  if (budget.mode === 'page') {
    logger.warn(
      { task, remainingUsd: budget.remainingUsd, ...ctx },
      'ai.budget.threshold_breached',
    )
  }

  const jsonSchema = zodToJsonSchema(schema, { name: schemaName, $refStrategy: 'none' })
  // zod-to-json-schema wraps the schema under `definitions` when given a
  // name; OpenAI Structured Outputs expects the inline schema object.
  const inlineSchema =
    (jsonSchema as { definitions?: Record<string, unknown> }).definitions?.[schemaName] ??
    jsonSchema

  const client = getOpenAI()
  const startedAt = Date.now()

  const completion = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schemaName,
        schema: inlineSchema as Record<string, unknown>,
        strict: true,
      },
    },
  })

  const latencyMs = Date.now() - startedAt
  const inputTokens = completion.usage?.prompt_tokens ?? 0
  const outputTokens = completion.usage?.completion_tokens ?? 0
  const costUsd = estimateCostUsd(model, inputTokens, outputTokens)

  recordUsage({ task, costUsd })

  const raw = completion.choices[0]?.message?.content ?? ''
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.error({ task, promptVersion, model, ...ctx }, 'ai.structured.invalid_json')
    throw new BusinessError('AI_OUTPUT_INVALID', 'Model returned non-JSON content.', {
      task,
    })
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    logger.error(
      { task, promptVersion, model, issues: result.error.issues, ...ctx },
      'ai.structured.schema_violation',
    )
    throw new BusinessError('AI_OUTPUT_INVALID', 'Model output failed schema validation.', {
      task,
      issues: result.error.issues,
    })
  }

  logger.info(
    {
      task,
      promptVersion,
      model,
      inputTokens,
      outputTokens,
      latencyMs,
      costUsd,
      ...ctx,
    },
    'ai.structured.completed',
  )

  // CLAUDE.md §18.3 — sample 1% of production calls for drift triage.
  await sampleForDrift({
    task,
    model,
    promptVersion,
    input: { user, ctx },
    output: result.data,
    costUsd,
  })

  return result.data
}
