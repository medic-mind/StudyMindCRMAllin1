// Inbox router. CLAUDE.md §11 (inbound messages), §20 (RBAC), §27 (cursor
// pagination).
// Lists the most recent inbound message Interactions across all unassigned
// conversations. Read-mostly route — visible to every authenticated role
// (ADR 0014). Virtual Assistants triage inbound by reading; they cannot send
// replies (that gate lives in the outbound interaction routers).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const ALLOWED_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const InboxListInput = z.object({
  cursor: z
    .object({
      id: z.string(),
      occurredAt: z.date(),
    })
    .nullish(),
  limit: z.number().min(1).max(100).default(25),
  /** Triage filter. `all` (default) surfaces everything not currently snoozed
   *  past `now`. `mine` returns rows where `inboxAssigneeId` equals the caller
   *  (i.e. messages the agent picked up). `unassigned` returns rows with no
   *  assignee. `snoozed` returns rows whose snooze is still in the future. */
  filter: z.enum(['all', 'mine', 'unassigned', 'snoozed']).default('all'),
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
  /** Who picked up the row, if anyone. Drives the "assigned to me" badge. */
  inboxAssigneeId: string | null
  /** When the row comes back into the active inbox. Null when not snoozed. */
  inboxSnoozedUntil: Date | null
}

export const inboxRouter = router({
  list: protectedProcedure
    .input(InboxListInput)
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }

      // Triage filters are applied post-fetch in JS. Prisma JSON predicates
      // cannot cleanly express "key missing", and the inbox is paginated
      // small enough (≤100/page) that filtering in-process is cheaper than
      // working around the predicate gap. We over-fetch by 4× to keep the
      // page full when the filter drops rows.
      const sweep = Math.min(input.limit * 4 + 1, 400)
      const rawRows = await ctx.db.interaction.findMany({
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
        take: sweep,
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

      const now = Date.now()
      const isSnoozedFuture = (raw: string | null): boolean =>
        raw !== null && new Date(raw).getTime() > now
      const filtered = rawRows.filter((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {}
        const assignee =
          typeof payload['inboxAssigneeId'] === 'string'
            ? (payload['inboxAssigneeId'] as string)
            : null
        const snoozedRaw =
          typeof payload['inboxSnoozedUntil'] === 'string'
            ? (payload['inboxSnoozedUntil'] as string)
            : null
        const snoozedNow = isSnoozedFuture(snoozedRaw)

        switch (input.filter) {
          case 'mine':
            return assignee === user.id && !snoozedNow
          case 'unassigned':
            return assignee === null && !snoozedNow
          case 'snoozed':
            return snoozedNow
          case 'all':
          default:
            return !snoozedNow
        }
      })

      const hasMore = filtered.length > input.limit
      const sliced = hasMore ? filtered.slice(0, input.limit) : filtered
      const items: InboxListItem[] = sliced.map((r) => {
        const payload = (r.payload as Record<string, unknown> | null) ?? {}
        const channel = typeof payload['channel'] === 'string' ? (payload['channel'] as string) : null
        const body = typeof payload['body'] === 'string' ? (payload['body'] as string) : null
        const inboxAssigneeId =
          typeof payload['inboxAssigneeId'] === 'string'
            ? (payload['inboxAssigneeId'] as string)
            : null
        const snoozedRaw =
          typeof payload['inboxSnoozedUntil'] === 'string'
            ? (payload['inboxSnoozedUntil'] as string)
            : null
        const inboxSnoozedUntil = snoozedRaw ? new Date(snoozedRaw) : null
        return {
          id: r.id,
          type: r.type,
          channel,
          occurredAt: r.occurredAt,
          summary: r.summary,
          preview: body ? body.slice(0, 160) : null,
          contactId: r.contactId,
          familyId: r.familyId,
          inboxAssigneeId,
          inboxSnoozedUntil,
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

  // ADR 0020 Phase 2b — Communication Centre seed. Reads the Conversation
  // head (not the polymorphic Interaction list) so the UI gets the
  // conversation's *current* status / assignee / channel / unread in a
  // single indexed query. The filter set mirrors inbox.list so the user's
  // mental model stays consistent across the two views.
  conversations: router({
    // ADR 0020 Phase 4 — single-conversation thread view for the Comms
    // Centre. Reads the head and the latest ~50 messages from Interaction
    // (the head references, never copies — CLAUDE.md §35).
    get: protectedProcedure
      .input(z.object({ conversationId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        const head = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: {
            id: true,
            trengoTicketId: true,
            contactId: true,
            familyId: true,
            channel: true,
            status: true,
            assigneeUserId: true,
            lastMessageAt: true,
            unreadCount: true,
            subject: true,
            tags: true,
            replyDeadlineAt: true,
            contact: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        })
        if (!head) throw new TRPCError({ code: 'NOT_FOUND' })

        const messageRows = await ctx.db.interaction.findMany({
          where: {
            deletedAt: null,
            type: 'message',
            payload: { path: ['ticketId'], equals: head.trengoTicketId },
          },
          orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
          take: 100,
          select: {
            id: true,
            occurredAt: true,
            summary: true,
            payload: true,
            createdById: true,
          },
        })

        const messages = messageRows.map((r) => {
          const payload = (r.payload as Record<string, unknown> | null) ?? {}
          const interactionType =
            typeof payload['interactionType'] === 'string'
              ? (payload['interactionType'] as string)
              : null
          const direction: 'inbound' | 'outbound' | 'unknown' =
            interactionType === 'message.outbound'
              ? 'outbound'
              : interactionType === 'message.inbound'
                ? 'inbound'
                : 'unknown'
          const body =
            typeof payload['body'] === 'string' ? (payload['body'] as string) : null
          return {
            id: r.id,
            occurredAt: r.occurredAt,
            direction,
            body: body ?? r.summary,
            authorId: r.createdById,
          }
        })

        return {
          head: {
            id: head.id,
            trengoTicketId: head.trengoTicketId,
            contactId: head.contactId,
            familyId: head.familyId,
            channel: head.channel,
            status: head.status,
            assigneeUserId: head.assigneeUserId,
            lastMessageAt: head.lastMessageAt,
            unreadCount: head.unreadCount,
            subject: head.subject,
            tags: head.tags,
            replyDeadlineAt: head.replyDeadlineAt,
            contactName: head.contact
              ? [head.contact.firstName, head.contact.lastName]
                  .filter((x): x is string => !!x)
                  .join(' ') || head.contact.email || null
              : null,
          },
          messages,
        }
      }),
    list: protectedProcedure
      .input(
        z.object({
          filter: z
            .enum(['active', 'mine', 'unassigned', 'closed', 'snoozed'])
            .default('active'),
          channel: z.enum(['whatsapp', 'sms', 'email', 'web_chat']).nullish(),
          cursor: z
            .object({ id: z.string(), lastMessageAt: z.date() })
            .nullish(),
          limit: z.number().int().min(1).max(100).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Inbox is staff-only.',
          })
        }

        const where: Record<string, unknown> = {}
        switch (input.filter) {
          case 'mine':
            where['assigneeUserId'] = user.id
            where['status'] = { in: ['open', 'snoozed'] }
            break
          case 'unassigned':
            where['assigneeUserId'] = null
            where['status'] = 'open'
            break
          case 'closed':
            where['status'] = 'closed'
            break
          case 'snoozed':
            where['status'] = 'snoozed'
            break
          case 'active':
          default:
            where['status'] = 'open'
            break
        }
        if (input.channel) where['channel'] = input.channel
        if (input.cursor) {
          where['OR'] = [
            { lastMessageAt: { lt: input.cursor.lastMessageAt } },
            {
              AND: [
                { lastMessageAt: input.cursor.lastMessageAt },
                { id: { lt: input.cursor.id } },
              ],
            },
          ]
        }

        const rows = await ctx.db.conversation.findMany({
          where,
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            trengoTicketId: true,
            contactId: true,
            familyId: true,
            channel: true,
            status: true,
            assigneeUserId: true,
            lastMessageAt: true,
            unreadCount: true,
            subject: true,
            tags: true,
            replyDeadlineAt: true,
            contact: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        })

        const hasMore = rows.length > input.limit
        const sliced = hasMore ? rows.slice(0, input.limit) : rows
        const items = sliced.map((r) => ({
          id: r.id,
          trengoTicketId: r.trengoTicketId,
          contactId: r.contactId,
          familyId: r.familyId,
          channel: r.channel,
          status: r.status,
          assigneeUserId: r.assigneeUserId,
          lastMessageAt: r.lastMessageAt,
          unreadCount: r.unreadCount,
          subject: r.subject,
          tags: r.tags,
          replyDeadlineAt: r.replyDeadlineAt,
          contactName: r.contact
            ? [r.contact.firstName, r.contact.lastName]
                .filter((x): x is string => !!x)
                .join(' ') || r.contact.email || null
            : null,
        }))
        const last = sliced[sliced.length - 1]
        const nextCursor =
          hasMore && last
            ? { id: last.id, lastMessageAt: last.lastMessageAt }
            : null
        return { items, nextCursor }
      }),
  }),
})
