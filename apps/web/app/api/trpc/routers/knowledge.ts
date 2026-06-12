// Protocols & Policies — the imported company knowledge base (ADR 0040).
//
// Reads go through the LIVE store (checked-in baseline, or the
// `KnowledgeOverride` row once the content has been edited in-app):
// `search` is a pure in-memory keyword search, `ask` is the AI Knowledge
// assistant grounded on the whole live knowledge base via @studymind/ai.
//
// The `edit` namespace is the CRM port of the Crib's AI editor: a CEO /
// Senior Manager describes a change in plain English, the AI proposes JSON
// patches, the human reviews and applies (§3 — AI suggests, humans
// confirm). Apply/reset are audited (`knowledge.updated` / `knowledge.reset`).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  buildKnowledgeEditPrompt,
  buildKnowledgeQaPrompt,
  KNOWLEDGE_EDIT_PROMPT_VERSION,
  KNOWLEDGE_QA_PROMPT_VERSION,
  knowledgeAnswerShape,
  knowledgeEditSchema,
  runDraft,
  runStructured,
} from '@studymind/ai'
import { BusinessError } from '@studymind/core'
import {
  applyKnowledgePatches,
  buildKnowledgeContext,
  getAtPath,
  KNOWLEDGE_OVERRIDE_ID,
  knowledgePatchSchema,
  loadKnowledgeStore,
  searchKnowledge,
  type KnowledgePatch,
} from '@studymind/core/knowledge'
import { logger } from '@studymind/core/logger'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

/** Who may edit the knowledge base — mirrors the Crib's super-admin AI
 *  editor (CEO + Senior Manager; the settings.write tier). */
const EDIT_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager'])

function requireEditor(ctx: Parameters<typeof requireUser>[0]) {
  const user = requireUser(ctx)
  if (!EDIT_ROLES.has(user.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the CEO or a Senior Manager can edit the knowledge base.',
    })
  }
  return user
}

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
  /** Keyword search across every live knowledge section. Any staff. */
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(2).max(200),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const store = await loadKnowledgeStore(ctx.db)
      return { results: searchKnowledge(store, input.query, input.limit ?? 20) }
    }),

  /** Whether in-app edits are live (vs the imported baseline). Any staff. */
  status: protectedProcedure.query(async ({ ctx }) => {
    const store = await loadKnowledgeStore(ctx.db)
    return {
      edited: store.edited,
      updatedAt: store.updatedAt ?? null,
      sectionCount: store.sections.length,
    }
  }),

  /**
   * AI Knowledge assistant. Grounds the model on the full LIVE knowledge
   * base (CLAUDE.md §18 — via packages/ai only) and returns a free-text
   * answer plus the most relevant sections as "read more" links. Any staff
   * — the assistant reads company knowledge, it cannot touch CRM data.
   */
  ask: protectedProcedure.input(AskInput).mutation(async ({ ctx, input }) => {
    const store = await loadKnowledgeStore(ctx.db)
    const context = buildKnowledgeContext(store, input.question)
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
          : 'The AI Knowledge assistant is unavailable — this usually means no AI provider key is configured. Ask an admin to set GEMINI_API_KEY (or OPENAI_API_KEY) on the web service in Railway. The Protocols & Policies sections are always available to browse and search.',
      })
    }
  }),

  edit: router({
    /**
     * Plain-English instruction → AI-proposed patches with current values
     * for review. Proposes only — nothing changes until `apply`.
     */
    propose: protectedProcedure
      .input(z.object({ instruction: z.string().trim().min(3).max(2_000) }))
      .mutation(async ({ ctx, input }) => {
        requireEditor(ctx)
        const store = await loadKnowledgeStore(ctx.db)
        const prompt = buildKnowledgeEditPrompt({
          instruction: input.instruction,
          currentJson: JSON.stringify(store.data),
          today: new Date().toISOString().slice(0, 10),
        })

        let proposal
        try {
          proposal = await runStructured({
            task: 'knowledge_edit',
            promptVersion: KNOWLEDGE_EDIT_PROMPT_VERSION,
            schema: knowledgeEditSchema,
            schemaName: 'knowledge_edit',
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o',
            temperature: 0.2,
            ctx: { source: 'knowledge.edit.propose', requestId: ctx.requestId },
          })
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'knowledge_edit.propose_failed',
          )
          const budgetHit = err instanceof BusinessError && err.code === 'AI_BUDGET_EXCEEDED'
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: budgetHit
              ? 'The AI editor has reached its daily budget — try again tomorrow.'
              : 'The AI editor is unavailable right now — try again shortly.',
          })
        }

        const patches = z.array(knowledgePatchSchema).parse(proposal.patches)

        // Dry-run so the reviewer sees upfront whether the set applies
        // cleanly; `apply` re-validates regardless.
        let validationError: string | null = null
        if (patches.length > 0) {
          try {
            applyKnowledgePatches(store.data, patches)
          } catch (err) {
            validationError =
              err instanceof BusinessError ? err.message : 'The proposed patches do not apply.'
          }
        }

        return {
          summary: proposal.summary,
          patches: patches.map((patch) => ({
            ...patch,
            current: getAtPath(store.data, patch.path).value ?? null,
          })),
          validationError,
        }
      }),

    /**
     * Commit human-confirmed patches to the live knowledge base. Writes the
     * full edited document to the override row, audited with the patch list.
     * (Named `commit` because `apply` is a reserved word in tRPC routers.)
     */
    commit: auditedProcedure
      .input(
        z.object({
          patches: z.array(knowledgePatchSchema).min(1).max(20),
          /** The proposal summary, kept in the audit trail. */
          summary: z.string().trim().max(1_000).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireEditor(ctx)
        const store = await loadKnowledgeStore(ctx.db)

        let next
        try {
          next = applyKnowledgePatches(store.data, input.patches as KnowledgePatch[])
        } catch (err) {
          if (err instanceof BusinessError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          throw err
        }

        await ctx.db.knowledgeOverride.upsert({
          where: { id: KNOWLEDGE_OVERRIDE_ID },
          create: {
            id: KNOWLEDGE_OVERRIDE_ID,
            data: next as object,
            createdById: user.id,
            updatedById: user.id,
          },
          update: { data: next as object, updatedById: user.id },
        })

        await ctx.audit({
          action: 'knowledge.updated',
          target: { type: 'KnowledgeOverride', id: KNOWLEDGE_OVERRIDE_ID },
          after: {
            summary: input.summary ?? null,
            patches: input.patches as object[],
          },
        })

        return { applied: input.patches.length }
      }),

    /** Discard every in-app edit and return to the imported baseline. */
    reset: auditedProcedure.mutation(async ({ ctx }) => {
      requireEditor(ctx)
      await ctx.db.knowledgeOverride.deleteMany({
        where: { id: KNOWLEDGE_OVERRIDE_ID },
      })
      await ctx.audit({
        action: 'knowledge.reset',
        target: { type: 'KnowledgeOverride', id: KNOWLEDGE_OVERRIDE_ID },
      })
      return { reset: true }
    }),
  }),
})
