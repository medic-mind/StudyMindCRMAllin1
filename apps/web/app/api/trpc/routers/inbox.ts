// Inbox router. CLAUDE.md §11 (inbound messages), §20 (RBAC), §27 (cursor
// pagination).
// Lists the most recent inbound message Interactions across all unassigned
// conversations. Role-gated: agent | ops_manager | admin | dsl.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const ALLOWED_ROLES: ReadonlySet<UserRole> = new Set(['agent', 'ops_manager', 'admin', 'dsl'])

const InboxListInput = z.object({
  cursor: z
    .object({
      id: z.string(),
      occurredAt: z.date(),
    })
    .nullish(),
  limit: z.number().min(1).max(100).default(25),
})

export interface InboxListItem {
  id: string
  type: string
  channel: string | null
  occurredAt: Date
  summary: string | null
  preview: string | null
  contactId: string | null
  familyId: string | null
}

export const inboxRouter = router({
  list: protectedProcedure
    .input(InboxListInput)
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }

      const rows = await ctx.db.interaction.findMany({
        where: {
          deletedAt: null,
          // The Prisma enum reuses `message` for both inbound and outbound;
          // the registered event name lives in payload.interactionType. We
          // surface only the inbound side here.
          type: 'message',
          payload: {
            path: ['interactionType'],
            equals: 'message.inbound',
          },
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
          payload: true,
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const items: InboxListItem[] = sliced.map((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {}
        const channel = typeof payload['channel'] === 'string' ? (payload['channel'] as string) : null
        const body = typeof payload['body'] === 'string' ? (payload['body'] as string) : null
        return {
          id: r.id,
          type: r.type,
          channel,
          occurredAt: r.occurredAt,
          summary: r.summary,
          preview: body ? body.slice(0, 160) : null,
          contactId: r.contactId,
          familyId: r.familyId,
        }
      })

      const last = sliced[sliced.length - 1]
      const nextCursor = hasMore && last ? { id: last.id, occurredAt: last.occurredAt } : null
      return { items, nextCursor }
    }),

  /**
   * Assign an inbound message to a user (typically the caller via "Assign to
   * me"). Stored in the Interaction payload as `inboxAssigneeId`. Audited.
   */
  assign: auditedProcedure
    .input(z.object({ interactionId: z.string(), assigneeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const row = await ctx.db.interaction.findFirst({
        where: { id: input.interactionId, deletedAt: null },
        select: { id: true, payload: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      const payload = (row.payload as Record<string, unknown> | null) ?? {}
      const next = { ...payload, inboxAssigneeId: input.assigneeId }
      await ctx.db.interaction.update({
        where: { id: row.id },
        data: { payload: next, updatedById: user.id },
      })
      await ctx.audit({
        action: 'inbox.message_assigned',
        target: { type: 'Interaction', id: row.id },
        before: { inboxAssigneeId: payload['inboxAssigneeId'] ?? null },
        after: { inboxAssigneeId: input.assigneeId },
      })
      return { id: row.id }
    }),

  /**
   * Snooze an inbound message for a duration. Stored as `inboxSnoozedUntil`
   * on the Interaction payload. List queries can later filter on this.
   */
  snooze: auditedProcedure
    .input(
      z.object({
        interactionId: z.string(),
        minutes: z.number().int().min(5).max(60 * 24 * 7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const row = await ctx.db.interaction.findFirst({
        where: { id: input.interactionId, deletedAt: null },
        select: { id: true, payload: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      const until = new Date(Date.now() + input.minutes * 60 * 1000)
      const payload = (row.payload as Record<string, unknown> | null) ?? {}
      const next = { ...payload, inboxSnoozedUntil: until.toISOString() }
      await ctx.db.interaction.update({
        where: { id: row.id },
        data: { payload: next, updatedById: user.id },
      })
      await ctx.audit({
        action: 'inbox.message_snoozed',
        target: { type: 'Interaction', id: row.id },
        after: { inboxSnoozedUntil: until.toISOString() },
      })
      return { id: row.id, snoozedUntil: until.toISOString() }
    }),
})
