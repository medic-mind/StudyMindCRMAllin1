// Inbox router. CLAUDE.md §11 (inbound messages), §20 (RBAC), §27 (cursor
// pagination).
// Lists the most recent inbound message Interactions across all unassigned
// conversations. Read-mostly route — visible to every authenticated role
// (ADR 0014). Virtual Assistants triage inbound by reading; they cannot send
// replies (that gate lives in the outbound interaction routers).

import { createId } from '@paralleldrive/cuid2'
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
            provider: true,
            externalThreadId: true,
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

        // ADR 0021 Phase 3b — email heads join their messages on
        // `payload.gmailThreadId`; Trengo heads on `payload.ticketId`.
        const messageRows =
          head.provider === 'email' && head.externalThreadId
            ? await ctx.db.interaction.findMany({
                where: {
                  deletedAt: null,
                  type: { in: ['email_received', 'email_sent'] },
                  payload: {
                    path: ['gmailThreadId'],
                    equals: head.externalThreadId,
                  },
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
            : head.trengoTicketId === null
              ? []
              : await ctx.db.interaction.findMany({
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
          // Email interactions (ADR 0021 Phase 3b) carry `event: email.sent|
          // email.received` instead of a Trengo `interactionType`.
          const emailEvent =
            typeof payload['event'] === 'string' ? (payload['event'] as string) : null
          const direction: 'inbound' | 'outbound' | 'unknown' =
            interactionType === 'message.outbound' || emailEvent === 'email.sent'
              ? 'outbound'
              : interactionType === 'message.inbound' || emailEvent === 'email.received'
                ? 'inbound'
                : 'unknown'
          const body =
            typeof payload['body'] === 'string'
              ? (payload['body'] as string)
              : typeof payload['subject'] === 'string'
                ? (payload['subject'] as string)
                : null
          // ADR 0020 Phase 6d — attachments are written by the download
          // worker as payload.attachments[]; surface enough for the UI to
          // render chips + link to the internal stream route.
          const rawAttachments = Array.isArray(payload['attachments'])
            ? (payload['attachments'] as Array<Record<string, unknown>>)
            : []
          const attachments = rawAttachments
            .filter((a) => a && typeof a === 'object')
            .map((a) => ({
              attachmentId:
                typeof a['attachmentId'] === 'string' ? (a['attachmentId'] as string) : '',
              filename:
                typeof a['filename'] === 'string' ? (a['filename'] as string) : 'file',
              mimeType:
                typeof a['mimeType'] === 'string'
                  ? (a['mimeType'] as string)
                  : 'application/octet-stream',
              sizeBytes:
                typeof a['sizeBytes'] === 'number' ? (a['sizeBytes'] as number) : null,
              status:
                typeof a['status'] === 'string' ? (a['status'] as string) : 'pending',
            }))
            .filter((a) => a.attachmentId !== '')
          return {
            id: r.id,
            occurredAt: r.occurredAt,
            direction,
            body: body ?? r.summary,
            authorId: r.createdById,
            attachments,
          }
        })

        return {
          head: {
            id: head.id,
            provider: head.provider,
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

        // ADR 0020 Phase 6 — resolve assignee user ids to display names in
        // one round-trip rather than N+1 joins. Empty when no row carries an
        // assignee.
        const assigneeIds = Array.from(
          new Set(
            rows
              .map((r) => r.assigneeUserId)
              .filter((id): id is string => typeof id === 'string'),
          ),
        )
        const assignees =
          assigneeIds.length > 0
            ? await ctx.db.user.findMany({
                where: { id: { in: assigneeIds } },
                select: { id: true, name: true, email: true },
              })
            : []
        const assigneeNameById = new Map(
          assignees.map((u) => [u.id, u.name ?? u.email] as const),
        )

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
          assigneeName: r.assigneeUserId
            ? (assigneeNameById.get(r.assigneeUserId) ?? null)
            : null,
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

    // ADR 0020 Phase 6i — bulk triage actions on the conversation list.
    // markRead / snooze / unsnooze are fast head-only `updateMany`s; close
    // loops the audited Trengo outbound per conversation (capped, sequential)
    // so each close genuinely syncs to Trengo. Returns a per-action summary.
    bulk: auditedProcedure
      .input(
        z.object({
          conversationIds: z.array(z.string().min(1)).min(1).max(100),
          action: z.enum(['markRead', 'close', 'snooze', 'unsnooze']),
          minutes: z.number().int().min(5).max(60 * 24 * 30).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        const ids = Array.from(new Set(input.conversationIds))
        const { publishConversationUpdate } = await import('@studymind/core/realtime')

        if (input.action === 'markRead') {
          const r = await ctx.db.conversation.updateMany({
            where: { id: { in: ids }, unreadCount: { gt: 0 } },
            data: { unreadCount: 0 },
          })
          for (const id of ids) {
            publishConversationUpdate({ id, trengoTicketId: null, lastMessageAt: null, contactId: null })
          }
          await ctx.audit({
            action: 'trengo.conversation_read',
            target: { type: 'System', id: 'bulk' },
            after: { count: r.count, ids: ids.length },
          })
          return { action: input.action, succeeded: r.count, failed: 0 }
        }

        if (input.action === 'snooze' || input.action === 'unsnooze') {
          const until =
            input.action === 'snooze'
              ? new Date(Date.now() + (input.minutes ?? 60) * 60_000)
              : null
          const r = await ctx.db.conversation.updateMany({
            where: { id: { in: ids } },
            data:
              input.action === 'snooze'
                ? { status: 'snoozed', snoozedUntil: until }
                : { status: 'open', snoozedUntil: null },
          })
          for (const id of ids) {
            publishConversationUpdate({ id, trengoTicketId: null, lastMessageAt: null, contactId: null })
          }
          await ctx.audit({
            action:
              input.action === 'snooze'
                ? 'trengo.conversation_snoozed'
                : 'trengo.conversation_unsnoozed',
            target: { type: 'System', id: 'bulk' },
            after: { count: r.count, snoozedUntil: until?.toISOString() ?? null },
          })
          return { action: input.action, succeeded: r.count, failed: 0 }
        }

        // close — loop the audited Trengo outbound. Only Trengo conversations
        // with a contact + ticket can be closed; others are skipped.
        const rows = await ctx.db.conversation.findMany({
          where: { id: { in: ids }, status: { not: 'closed' } },
          select: { id: true, contactId: true, trengoTicketId: true },
        })
        const { closeConversation } = await import(
          '@studymind/integration-trengo/outbound'
        )
        let succeeded = 0
        let failed = 0
        let skipped = 0
        for (const row of rows) {
          if (!row.contactId || row.trengoTicketId === null) {
            skipped += 1
            continue
          }
          try {
            await closeConversation({
              contactId: row.contactId,
              agentId: user.id,
              ticketId: row.trengoTicketId,
              requestId: `${ctx.requestId}:${row.id}`,
            })
            succeeded += 1
          } catch {
            // Left in pending_send by the outbound; the retry cron recovers it.
            failed += 1
          }
        }
        await ctx.audit({
          action: 'trengo.ticket_close_requested',
          target: { type: 'System', id: 'bulk' },
          after: { succeeded, failed, skipped, selected: ids.length },
        })
        return { action: 'close', succeeded, failed, skipped }
      }),

    // ADR 0021 Phase 6 — internal notes + @mentions on a conversation. Notes
    // are staff↔staff (a `note` Interaction scoped by `payload.conversationId`)
    // and never sent outbound. A mention writes an audit row targeting the
    // colleague so it lands in their notifications. All staff may add notes
    // (§20 — VA "writes notes").
    notes: router({
      list: protectedProcedure
        .input(z.object({ conversationId: z.string() }))
        .query(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          if (!ALLOWED_ROLES.has(user.role)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
          }
          const rows = await ctx.db.interaction.findMany({
            where: {
              deletedAt: null,
              type: 'note',
              payload: { path: ['conversationId'], equals: input.conversationId },
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
          const authorIds = Array.from(
            new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x)),
          )
          const authors =
            authorIds.length > 0
              ? await ctx.db.user.findMany({
                  where: { id: { in: authorIds } },
                  select: { id: true, name: true, email: true },
                })
              : []
          const nameById = new Map(authors.map((u) => [u.id, u.name ?? u.email] as const))
          return rows.map((r) => {
            const p = (r.payload as Record<string, unknown> | null) ?? {}
            const mentions = Array.isArray(p['mentionedUserIds'])
              ? (p['mentionedUserIds'] as string[])
              : []
            return {
              id: r.id,
              occurredAt: r.occurredAt,
              body: typeof p['body'] === 'string' ? (p['body'] as string) : r.summary,
              authorId: r.createdById,
              authorName: r.createdById ? (nameById.get(r.createdById) ?? null) : null,
              mentions,
            }
          })
        }),

      add: auditedProcedure
        .input(
          z.object({
            conversationId: z.string(),
            body: z.string().trim().min(1).max(10_000),
            mentionUserIds: z.array(z.string()).max(20).optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          if (!ALLOWED_ROLES.has(user.role)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
          }
          const convo = await ctx.db.conversation.findUnique({
            where: { id: input.conversationId },
            select: { id: true, contactId: true, trengoTicketId: true },
          })
          if (!convo) throw new TRPCError({ code: 'NOT_FOUND' })

          const mentions = Array.from(new Set(input.mentionUserIds ?? []))

          // ADR 0020 Phase 6f — when this is a Trengo conversation, also push
          // the note to Trengo's internal-notes endpoint so colleagues working
          // there see it. Best-effort: a Trengo failure must not lose the
          // note, which is already the CRM source of truth. We stamp the sync
          // outcome onto the note payload for transparency.
          let trengoNoteId: number | null = null
          let trengoSync: 'synced' | 'failed' | null = null
          if (convo.trengoTicketId !== null) {
            try {
              const { pushInternalNoteToTrengo } = await import(
                '@studymind/integration-trengo/outbound'
              )
              const r = await pushInternalNoteToTrengo({
                agentId: user.id,
                ticketId: convo.trengoTicketId,
                body: input.body,
                requestId: ctx.requestId,
              })
              trengoNoteId = r.trengoNoteId
              trengoSync = 'synced'
            } catch {
              trengoSync = 'failed'
            }
          }

          const noteId = createId()
          await ctx.db.interaction.create({
            data: {
              id: noteId,
              type: 'note',
              contactId: convo.contactId,
              occurredAt: new Date(),
              summary: input.body.slice(0, 280),
              payload: {
                conversationId: convo.id,
                body: input.body,
                mentionedUserIds: mentions,
                internal: true,
                ...(trengoSync ? { trengoSync, trengoNoteId } : {}),
              },
              createdById: user.id,
              updatedById: user.id,
            },
          })
          await ctx.audit({
            action: 'conversation.note_added',
            target: { type: 'Conversation', id: convo.id },
            after: { noteId, mentions },
          })
          // Notify each mentioned colleague (skip self). The audit row's
          // targetId surfaces in their notifications feed.
          for (const uid of mentions) {
            if (uid === user.id) continue
            await ctx.audit({
              action: 'conversation.note_mentioned',
              target: { type: 'User', id: uid },
              after: { conversationId: convo.id, noteId },
            })
          }
          return { id: noteId }
        }),
    }),
  }),
})
