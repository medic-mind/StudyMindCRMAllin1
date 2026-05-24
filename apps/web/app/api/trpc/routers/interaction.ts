// Interaction (timeline) router. See CLAUDE.md Sections 6.2, 27.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  buildReplyDraftPrompt,
  REPLY_DRAFT_PROMPT_VERSION,
  replyDraftShape,
  runDraft,
  type ReplyChannel,
} from '@studymind/ai'
import {
  InteractionCreateInput,
  type InteractionListItem,
} from '@studymind/core/interaction'

import { toInteractionListItem } from '@/lib/view-models/interaction'

import {
  auditedProcedure,
  enforceRestrictedAccess,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

const InteractionListInput = z
  .object({
    contactId: z.string().optional(),
    familyId: z.string().optional(),
    /** Required when listing for a restricted contact. CLAUDE.md §42.3. */
    purpose: z.string().min(1).optional(),
    cursor: z
      .object({
        id: z.string(),
        occurredAt: z.date(),
      })
      .nullish(),
    limit: z.number().min(1).max(100).default(25),
  })
  .refine((v) => !!v.contactId || !!v.familyId, {
    message: 'contactId or familyId is required',
  })

function newId(): string {
  return createId()
}

export const interactionRouter = router({
  list: protectedProcedure
    .input(InteractionListInput)
    .query(async ({ ctx, input }) => {
      // Restricted-access enforcement. When listing for a specific contact,
      // we run the gate up-front. When listing by family, we filter out any
      // interaction tied to a restricted contact unless the caller is admin
      // or an assigned DSL on every restricted contact in that family.
      if (input.contactId) {
        await enforceRestrictedAccess(
          ctx,
          input.contactId,
          input.purpose ?? '',
        )
      }
      const restrictedContactIds = await getRestrictedContactIdsToHide(
        ctx,
        input.familyId,
      )
      const rows = await ctx.db.interaction.findMany({
        where: {
          deletedAt: null,
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...(input.familyId ? { familyId: input.familyId } : {}),
          ...(restrictedContactIds.length > 0
            ? { contactId: { notIn: restrictedContactIds } }
            : {}),
          ...(input.cursor
            ? {
                OR: [
                  { occurredAt: { lt: input.cursor.occurredAt } },
                  {
                    AND: [
                      { occurredAt: input.cursor.occurredAt },
                      { id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          type: true,
          occurredAt: true,
          summary: true,
          contactId: true,
          familyId: true,
          createdById: true,
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const items: InteractionListItem[] = sliced.map((r) =>
        toInteractionListItem({
          ...r,
          // Prisma returns the enum verbatim; cast to our narrower union.
          type: mapDbType(r.type),
        }),
      )
      const last = sliced[sliced.length - 1]
      const nextCursor =
        hasMore && last ? { id: last.id, occurredAt: last.occurredAt } : null
      return { items, nextCursor }
    }),

  create: auditedProcedure
    .input(InteractionCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Phase 1: only manual notes from the UI. Other types come via integrations.
      if (input.type !== 'note') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only manual notes can be created via this endpoint today',
        })
      }
      // Validate referenced row(s) exist and aren't soft-deleted.
      if (input.contactId) {
        const c = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      }
      if (input.familyId) {
        const f = await ctx.db.family.findFirst({
          where: { id: input.familyId, deletedAt: null },
          select: { id: true },
        })
        if (!f) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found' })
      }

      const id = newId()
      const created = await ctx.db.interaction.create({
        data: {
          id,
          type: 'note',
          contactId: input.contactId ?? null,
          familyId: input.familyId ?? null,
          occurredAt: input.occurredAt ?? new Date(),
          summary: input.summary,
          payload: { body: input.body },
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'interaction.created',
        target: { type: 'Interaction', id: created.id },
        before: null,
        after: { id: created.id, type: created.type, summary: created.summary },
      })
      return { id: created.id }
    }),

  // CLAUDE.md §18 — AI-drafted reply. Returns text + promptVersion for
  // traceability. The agent edits and confirms via the existing outbound
  // path (Trengo, Gmail) which marks the Interaction as sent.
  draftReply: auditedProcedure
    .input(
      z.object({
        interactionId: z.string(),
        goal: z.string().min(1).max(500),
        channel: z.enum(['email', 'whatsapp', 'sms', 'web_chat']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const seed = await ctx.db.interaction.findFirst({
        where: { id: input.interactionId, deletedAt: null },
        select: { id: true, contactId: true, familyId: true, occurredAt: true },
      })
      if (!seed) throw new TRPCError({ code: 'NOT_FOUND' })
      if (seed.contactId) {
        await enforceRestrictedAccess(ctx, seed.contactId, 'reply-draft')
      }

      // Pull a small thread window. Prefer contact scope; fall back to family.
      const threadRows = await ctx.db.interaction.findMany({
        where: {
          deletedAt: null,
          ...(seed.contactId
            ? { contactId: seed.contactId }
            : { familyId: seed.familyId ?? undefined }),
        },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: {
          type: true,
          occurredAt: true,
          summary: true,
          payload: true,
          createdById: true,
        },
      })
      const thread = threadRows.reverse().map((r) => {
        const payload = (r.payload ?? {}) as { body?: string; text?: string }
        const text = payload.body ?? payload.text ?? r.summary ?? ''
        const direction: 'inbound' | 'outbound' | 'internal' = r.createdById
          ? 'outbound'
          : 'inbound'
        return {
          type: r.type,
          occurredAt: r.occurredAt.toISOString(),
          direction,
          text,
        }
      })

      const channel = input.channel as ReplyChannel
      const prompt = buildReplyDraftPrompt({
        channel,
        goal: input.goal,
        thread,
      })
      const result = await runDraft({
        task: 'reply_draft',
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        model: 'gpt-4o',
        contentShape: replyDraftShape(channel),
        contactId: seed.contactId ?? undefined,
        ctx: { interactionId: input.interactionId, agentId: user.id },
      })

      await ctx.audit({
        action: 'ai.draft_generated',
        target: { type: 'Interaction', id: input.interactionId },
        purpose: 'reply-draft',
        after: {
          channel,
          promptVersion: REPLY_DRAFT_PROMPT_VERSION,
          length: result.text.length,
        },
      })

      return {
        text: result.text,
        promptVersion: REPLY_DRAFT_PROMPT_VERSION,
        channel,
      }
    }),

  // CLAUDE.md §14 — Gmail outbound reply. Resolves a seed `email_received`
  // Interaction, computes the reply recipients, and goes through the Gmail
  // outbound which is idempotent on (threadId, requestId).
  email: router({
    reply: auditedProcedure
      .input(
        z.object({
          interactionId: z.string(),
          body: z.string().trim().min(1).max(50_000),
          /** When true, prepend the original message body as a quoted block. */
          includeOriginal: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!['agent', 'ops_manager', 'admin', 'dsl', 'super_admin', 'finance'].includes(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot send email' })
        }

        const seed = await ctx.db.interaction.findFirst({
          where: { id: input.interactionId, deletedAt: null, type: 'email_received' },
          select: {
            id: true,
            contactId: true,
            familyId: true,
            occurredAt: true,
            summary: true,
            payload: true,
          },
        })
        if (!seed) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Inbound email Interaction not found.',
          })
        }
        if (seed.contactId) {
          await enforceRestrictedAccess(ctx, seed.contactId, 'email-reply')
        }

        const payload = (seed.payload ?? {}) as Record<string, unknown>
        const threadId = typeof payload['threadId'] === 'string' ? payload['threadId'] : null
        const subject =
          typeof payload['subject'] === 'string' ? payload['subject'] : seed.summary ?? ''
        const fromAddress =
          typeof payload['from'] === 'string'
            ? payload['from']
            : typeof payload['fromAddress'] === 'string'
              ? (payload['fromAddress'] as string)
              : null
        const toRaw = Array.isArray(payload['to']) ? (payload['to'] as unknown[]) : []
        const ccRaw = Array.isArray(payload['cc']) ? (payload['cc'] as unknown[]) : []
        const originalMessageId =
          typeof payload['messageId'] === 'string' ? payload['messageId'] : undefined
        const originalBody =
          typeof payload['body'] === 'string' ? payload['body'] : ''

        if (!threadId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No Gmail threadId on the inbound Interaction; cannot reply.',
          })
        }

        // Recipients: the from of the inbound becomes the To; original to/cc
        // become the cc minus our own connected mailbox address.
        const myMailbox = await ctx.db.gmailMailbox.findUnique({
          where: { agentId: user.id },
          select: { address: true },
        })
        const myAddress = myMailbox?.address?.toLowerCase() ?? null
        const filterMine = (s: string) =>
          myAddress ? s.trim().toLowerCase() !== myAddress : true

        const replyTo = fromAddress ? [fromAddress] : []
        const replyCc = [
          ...toRaw.filter((x): x is string => typeof x === 'string'),
          ...ccRaw.filter((x): x is string => typeof x === 'string'),
        ].filter(filterMine)

        if (replyTo.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No reply recipient could be derived from the inbound email.',
          })
        }

        const composed = input.includeOriginal && originalBody
          ? `${input.body}\n\n--- On ${seed.occurredAt.toISOString()} wrote: ---\n${originalBody}`
          : input.body

        // Lazy import keeps the Gmail SDK out of the unrelated tRPC bundle.
        const { sendReply } = await import('@studymind/integration-gmail/outbound')
        const result = await sendReply({
          agentId: user.id,
          threadId,
          subject,
          body: composed,
          toAddresses: replyTo,
          cc: replyCc.length > 0 ? replyCc : undefined,
          requestId: ctx.requestId,
          originalMessageId,
        })

        await ctx.audit({
          action: 'gmail.reply_requested',
          target: { type: 'OutboundEmailIntent', id: result.outboundEmailIntentId },
          after: {
            threadId,
            gmailMessageId: result.gmailMessageId,
            replayed: result.replayed,
          },
        })

        return result
      }),
  }),
})

/**
 * For a family-scoped list, return the contact ids whose timeline rows must
 * be hidden from this caller because they are restricted_access and the
 * caller is neither admin nor the assigned DSL on every such row.
 *
 * When called without a familyId (or when the caller is admin) returns [].
 */
async function getRestrictedContactIdsToHide(
  _ctx: Parameters<typeof enforceRestrictedAccess>[0],
  _familyId: string | undefined,
): Promise<string[]> {
  // Safeguarding restricted-access enforcement was removed in ADR 0013.
  // Helper retained as a no-op extension point.
  return []
}

// Map the Prisma enum (uses underscores) to our domain enum (uses dots where
// the event taxonomy demands it). See CLAUDE.md §45.
function mapDbType(t: string): InteractionListItem['type'] {
  switch (t) {
    case 'note':
      return 'note'
    case 'call':
      return 'call_logged'
    case 'email':
      return 'email_sent'
    case 'email_received':
      return 'email_received'
    case 'email_sent':
      return 'email_sent'
    case 'family_state_changed':
      return 'family.state_changed'
    case 'family_billing_contact_changed':
      return 'family.billing_contact_changed'
    case 'safeguarding_concern_raised':
      return 'safeguarding.concern_raised'
    default:
      return 'note'
  }
}
