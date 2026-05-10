// Drafting OpenAI client wrapper. Free-text output, validated post-hoc.
// See CLAUDE.md Sections 18.1 and 18.2.
//
// Drafting tasks (reply, tender) cannot use structured outputs because the
// content is prose. We instead validate with a small Zod schema describing
// length bounds and the absence of leakage markers (e.g. literal
// `[REDACTED:...]` strings indicate the model regurgitated a redacted token,
// which means our pre-prompt sanitisation failed or the model is confused).

import { BusinessError, logger } from '@studymind/core'
import { z } from 'zod'

import { type AiTaskCategory, checkBudget, recordUsage } from '../budget'
import { sampleForDrift } from '../drift'
import { assertContactNotRestricted } from './restricted-guard'
import { getOpenAI } from './openai'
import { estimateCostUsd } from './pricing'

export type DraftModel = 'gpt-4o' | 'gpt-4o-mini'

/**
 * Default content-shape check: 1..4000 characters, no [REDACTED:*] markers
 * leaking through into the model output. Callers can override.
 */
export const defaultDraftShape: z.ZodType<string> = z
  .string()
  .min(1, 'draft is empty')
  .max(4000, 'draft exceeds length budget')
  .refine((s) => !/\[REDACTED:[a-z]+\]/i.test(s), {
    message: 'draft contains a leaked redaction marker',
  })

export interface RunDraftInput {
  task: AiTaskCategory
  promptVersion: string
  system: string
  user: string
  model?: DraftModel
  temperature?: number
  contentShape?: z.ZodType<string>
  ctx?: Record<string, unknown>
  /** When provided, the call aborts if this contact is restricted_access. */
  contactId?: string
}

export interface RunDraftResult {
  text: string
}

export async function runDraft(input: RunDraftInput): Promise<RunDraftResult> {
  const {
    task,
    promptVersion,
    system,
    user,
    model = 'gpt-4o',
    temperature = 0.7,
    contentShape = defaultDraftShape,
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

  const client = getOpenAI()
  const startedAt = Date.now()

  const completion = await client.chat.completions.create({
    model,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })

  const latencyMs = Date.now() - startedAt
  const inputTokens = completion.usage?.prompt_tokens ?? 0
  const outputTokens = completion.usage?.completion_tokens ?? 0
  const costUsd = estimateCostUsd(model, inputTokens, outputTokens)

  recordUsage({ task, costUsd })

  const text = completion.choices[0]?.message?.content?.trim() ?? ''

  const result = contentShape.safeParse(text)
  if (!result.success) {
    logger.error(
      { task, promptVersion, model, issues: result.error.issues, ...ctx },
      'ai.draft.shape_violation',
    )
    throw new BusinessError('AI_OUTPUT_INVALID', 'Draft failed content-shape validation.', {
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
    'ai.draft.completed',
  )

  // CLAUDE.md §18.3 — drift sampling. Output text is bounded; input is the
  // user-side prompt content already sanitised by the prompt builder.
  await sampleForDrift({
    task,
    model,
    promptVersion,
    input: { user, ctx },
    output: { text: result.data },
    costUsd,
  })

  return { text: result.data }
}
