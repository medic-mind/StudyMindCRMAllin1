// Protocols & Policies — the imported company knowledge base (ADR 0040).
//
// Read-only over a static checked-in snapshot (the Crib import): `search`
// is a pure in-memory keyword search, `ask` is the AI Knowledge assistant
// grounded on the whole knowledge base via @studymind/ai. Nothing here
// touches Contacts, money or safeguarding — no audit obligations (§27);
// every AI call is logged/budgeted inside packages/ai (§18).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  buildKnowledgeQaPrompt,
  KNOWLEDGE_QA_PROMPT_VERSION,
  knowledgeAnswerShape,
  runDraft,
} from '@studymind/ai'
import { BusinessError } from '@studymind/core'
import { buildKnowledgeContext, searchKnowledge } from '@studymind/core/knowledge'
import { logger } from '@studymind/core/logger'

import { protectedProcedure, router } from '@/lib/trpc/builders'

const HISTORY_TURNS_MAX = 12

const AskInput = z.object({
  question: z.string().trim().min(3).max(2_000),
  /** Prior turns of this conversation, oldest first. */
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(4_000),
      }),
    )
    .max(HISTORY_TURNS_MAX)
    .optional(),
})

export const knowledgeRouter = router({
  /** Keyword search across every imported knowledge section. Any staff. */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(({ input }) => ({
      results: searchKnowledge(input.query, input.limit ?? 20),
    })),

  /**
   * AI Knowledge assistant. Grounds the model on the full knowledge base
   * (CLAUDE.md §18 — via packages/ai only) and returns a free-text answer
   * plus the most relevant sections as "read more" links. Any staff — the
   * assistant reads company knowledge, it cannot touch CRM data.
   */
  ask: protectedProcedure.input(AskInput).mutation(async ({ ctx, input }) => {
    const context = buildKnowledgeContext(input.question)
    const prompt = buildKnowledgeQaPrompt({
      question: input.question,
      contextJson: context.contextJson,
      today: new Date().toISOString().slice(0, 10),
      history: input.history,
    })

    try {
      const result = await runDraft({
        task: 'knowledge_qa',
        promptVersion: KNOWLEDGE_QA_PROMPT_VERSION,
        system: prompt.system,
        user: prompt.user,
        model: 'gpt-4o',
        temperature: 0.2,
        contentShape: knowledgeAnswerShape,
        ctx: { source: 'knowledge.ask', requestId: ctx.requestId },
      })
      return {
        answer: result.text,
        related: context.related.map(({ slug, title }) => ({ slug, title })),
        truncatedContext: context.truncated,
      }
    } catch (err) {
      // Expected degradations (budget exhausted, provider not configured)
      // get a friendly, actionable message — the browsable knowledge base
      // is always available as the fallback. Never mask a real bug as 500
      // here; runDraft already reported it (§25, §27).
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'knowledge_qa.ask_failed',
      )
      const budgetHit = err instanceof BusinessError && err.code === 'AI_BUDGET_EXCEEDED'
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: budgetHit
          ? 'The AI Knowledge assistant has reached its daily budget. Browse the Protocols & Policies sections directly, or try again tomorrow.'
          : 'The AI Knowledge assistant is unavailable right now. The Protocols & Policies sections are always available to browse and search.',
      })
    }
  }),
})
