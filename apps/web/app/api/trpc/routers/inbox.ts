// Inbox router. CLAUDE.md §11 (inbound messages), §20 (RBAC), §27 (cursor
// pagination).
// Lists the most recent inbound message Interactions across all unassigned
// conversations. Read-mostly route — visible to every authenticated role
// (ADR 0014). Virtual Assistants triage inbound by reading; they cannot send
// replies (that gate lives in the outbound interaction routers).

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'
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

/**
 * Conversation ids where `userId` was @mentioned in an internal note — the
 * Trengo "Mentioned" folder. Derived from the note Interactions
 * (payload.conversationId + payload.mentionedUserIds) so it needs no extra
 * table. Bounded so a heavily-mentioned user can't pull an unbounded set.
 */
async function mentionedConversationIds(
  db: PrismaClient,
  userId: string,
): Promise<string[]> {
  const rows = await db.interaction.findMany({
    where: {
      deletedAt: null,
      type: 'note',
      payload: { path: ['mentionedUserIds'], array_contains: userId },
    },
    orderBy: { occurredAt: 'desc' },
    take: 500,
    select: { payload: true },
  })
  const ids = new Set<string>()
  for (const r of rows) {
    const cid = (r.payload as Record<string, unknown> | null)?.['conversationId']
    if (typeof cid === 'string' && cid !== '') ids.add(cid)
  }
  return [...ids]
}

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
            mailAccountId: true,
            trengoTicketId: true,
            contactId: true,
            familyId: true,
            channel: true,
            status: true,
            isStarred: true,
            assigneeUserId: true,
            trengoAssigneeId: true,
            lastMessageAt: true,
            unreadCount: true,
            subject: true,
            tags: true,
            lastMessagePreview: true,
            replyDeadlineAt: true,
            trengoChannelName: true,
            favorites: { where: { userId: user.id }, select: { conversationId: true } },
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
              },
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
                  type: true,
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
                    type: {
                      in: ['message', 'ticket_closed', 'ticket_reopened', 'ticket_assigned'],
                    },
                    // Tolerate both id shapes: some Trengo workspaces send
                    // numeric strings, and older rows were stored that way —
                    // a strict number match left those messages invisible.
                    OR: [
                      { payload: { path: ['ticketId'], equals: head.trengoTicketId } },
                      {
                        payload: {
                          path: ['ticketId'],
                          equals: String(head.trengoTicketId),
                        },
                      },
                    ],
                  },
                  orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
                  take: 100,
                  select: {
                    id: true,
                    type: true,
                    occurredAt: true,
                    summary: true,
                    payload: true,
                    createdById: true,
                  },
                })

        // Resolve CRM authors (replies sent from the CRM carry createdById)
        // in one batch so each outbound bubble can name its sender.
        const authorIds = [
          ...new Set(
            messageRows
              .map((r) => r.createdById)
              .filter((x): x is string => typeof x === 'string' && x !== ''),
          ),
        ]
        const authors = authorIds.length
          ? await ctx.db.user.findMany({
              where: { id: { in: authorIds } },
              select: { id: true, name: true, email: true },
            })
          : []
        const authorNameById = new Map(
          authors.map((u) => [u.id, u.name ?? u.email] as const),
        )

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
          // ADR 0041 — sanitised email HTML (when synced). The /mail reading
          // pane renders it in a locked sandboxed iframe so the message looks
          // exactly as in Gmail; null falls back to the plaintext `body`.
          const bodyHtml =
            typeof payload['bodyHtml'] === 'string' &&
            (payload['bodyHtml'] as string).length > 0
              ? (payload['bodyHtml'] as string)
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
          // ADR 0021 Phase 4 — email attachments (payload.attachments[] carry
          // an `s3Key`, no Trengo attachmentId). Surface them by index so the
          // /mail reading pane can link to the download route. Keep the
          // (S3-stored) ones only.
          const mailAttachments = rawAttachments
            .map((a, i) => ({
              index: i,
              filename:
                typeof a['filename'] === 'string' ? (a['filename'] as string) : 'file',
              mimeType:
                typeof a['mimeType'] === 'string'
                  ? (a['mimeType'] as string)
                  : 'application/octet-stream',
              sizeBytes:
                typeof a['sizeBytes'] === 'number' ? (a['sizeBytes'] as number) : null,
              stored: typeof a['s3Key'] === 'string' && (a['s3Key'] as string).length > 0,
            }))
            .filter((a) => a.stored)
          // Sender attribution: imported/webhook rows carry the Trengo name
          // (payload.senderName — agent for outbound, customer for inbound);
          // CRM-sent replies resolve their author from createdById.
          const payloadSender =
            typeof payload['senderName'] === 'string' &&
            (payload['senderName'] as string).trim() !== ''
              ? (payload['senderName'] as string)
              : null
          // For inbound email with no stored display name (legacy rows), fall
          // back to the From address so the thread shows the real sender, never a
          // single matched contact for every message.
          const fromAddress =
            direction === 'inbound' &&
            Array.isArray(payload['from']) &&
            typeof (payload['from'] as unknown[])[0] === 'string'
              ? ((payload['from'] as string[])[0] as string)
              : null
          const senderName =
            payloadSender ??
            fromAddress ??
            (r.createdById ? (authorNameById.get(r.createdById) ?? null) : null)
          // Lifecycle rows render as centred system separators ("Closed by …"),
          // exactly like Trengo's thread.
          const kind: 'message' | 'system' = r.type === 'message' ? 'message' : 'system'
          const systemText =
            kind === 'system'
              ? `${
                  r.type === 'ticket_closed'
                    ? 'Closed'
                    : r.type === 'ticket_reopened'
                      ? 'Reopened'
                      : 'Assigned'
                }${senderName ? ` by ${senderName}` : ''}`
              : null
          // Send state of CRM-sent messages (two-phase outbound): pending_send
          // with an error = failed (the retry cron keeps trying); pending_send
          // without one = in flight. Surfacing this is what makes a stuck
          // send VISIBLE in the thread instead of silently looking sent.
          const rawStatus =
            typeof payload['status'] === 'string' ? (payload['status'] as string) : null
          const lastError = payload['lastError']
          const sendError =
            lastError !== null &&
            typeof lastError === 'object' &&
            typeof (lastError as Record<string, unknown>)['message'] === 'string'
              ? ((lastError as Record<string, unknown>)['message'] as string)
              : null
          const sendStatus: 'sending' | 'failed' | 'sent' | null =
            rawStatus === 'pending_send'
              ? sendError
                ? 'failed'
                : 'sending'
              : rawStatus === 'sent'
                ? 'sent'
                : null
          // Email messages carry a Gmail message id — the reading pane renders
          // ALL of them via the render route (which live-fetches the HTML when
          // it wasn't stored), so images show even for older mail.
          const gmailMessageId =
            typeof payload['gmailMessageId'] === 'string'
              ? (payload['gmailMessageId'] as string)
              : null
          return {
            id: r.id,
            kind,
            systemText,
            occurredAt: r.occurredAt,
            direction,
            body: body ?? r.summary,
            bodyHtml,
            gmailMessageId,
            authorId: r.createdById,
            senderName,
            sendStatus,
            sendError,
            attachments,
            mailAttachments,
          }
        })

        // Resolve the assignee's display name — from the CRM user when the
        // agent logs into the CRM, else the Trengo team mirror (so a Trengo-
        // only agent still shows by name).
        const assigneeRow = head.assigneeUserId
          ? await ctx.db.user.findUnique({
              where: { id: head.assigneeUserId },
              select: { name: true, email: true },
            })
          : head.trengoAssigneeId !== null
            ? await ctx.db.trengoUser.findUnique({
                where: { trengoUserId: head.trengoAssigneeId },
                select: { name: true, email: true },
              })
            : null
        const assigneeName = assigneeRow ? (assigneeRow.name ?? assigneeRow.email ?? null) : null

        return {
          head: {
            id: head.id,
            provider: head.provider,
            mailAccountId: head.mailAccountId,
            isStarred: head.isStarred,
            trengoTicketId: head.trengoTicketId,
            contactId: head.contactId,
            familyId: head.familyId,
            channel: head.channel,
            status: head.status,
            assigneeUserId: head.assigneeUserId,
            trengoAssigneeId: head.trengoAssigneeId,
            assigneeName,
            lastMessageAt: head.lastMessageAt,
            unreadCount: head.unreadCount,
            subject: head.subject,
            tags: head.tags,
            replyDeadlineAt: head.replyDeadlineAt,
            isFavorite: head.favorites.length > 0,
            trengoChannelName: head.trengoChannelName,
            contactName: head.contact
              ? [head.contact.firstName, head.contact.lastName]
                  .filter((x): x is string => !!x)
                  .join(' ') ||
                head.contact.email ||
                head.contact.phoneE164 ||
                null
              : null,
            contactEmail: head.contact?.email ?? null,
            contactPhone: head.contact?.phoneE164 ?? null,
          },
          messages,
        }
      }),
    list: protectedProcedure
      .input(
        z.object({
          filter: z
            .enum([
              'active',
              'mine',
              'assigned',
              'unassigned',
              'closed',
              'snoozed',
              'mentioned',
              'favorites',
              'spam',
            ])
            .default('active'),
          channel: z.enum(['whatsapp', 'sms', 'email', 'web_chat']).nullish(),
          /** Trengo label filter — matches Conversation.tags. Single (legacy)
           *  or multi-select; multi uses OR (has-any) semantics like Trengo. */
          tag: z.string().trim().min(1).max(80).nullish(),
          tags: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
          /** Trengo "Teams" folder — open conversations assigned to a member
           *  of this team. Overrides the status `filter` when set. */
          teamId: z.string().min(1).nullish(),
          /** Trengo "Channel" folder — the specific business number / inbox. */
          trengoChannelId: z.number().int().nullish(),
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
        if (input.teamId) {
          // Teams folder: open conversations whose assignee is on the team.
          const members = await ctx.db.teamMember.findMany({
            where: { teamId: input.teamId },
            select: { userId: true },
          })
          where['status'] = 'open'
          where['assigneeUserId'] = { in: members.map((m) => m.userId) }
        } else
        switch (input.filter) {
          case 'mine':
            where['assigneeUserId'] = user.id
            where['status'] = { in: ['open', 'snoozed'] }
            break
          case 'assigned':
            where['assigneeUserId'] = { not: null }
            where['status'] = 'open'
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
          case 'spam':
            where['status'] = 'spam'
            break
          case 'favorites':
            // Personal → Favorites: conversations this user has starred.
            where['favorites'] = { some: { userId: user.id } }
            break
          case 'mentioned': {
            // Personal → Mentioned: conversations where a note @mentioned me.
            // Derived from the note Interactions (no extra table).
            where['id'] = { in: await mentionedConversationIds(ctx.db, user.id) }
            break
          }
          case 'active':
          default:
            where['status'] = 'open'
            break
        }
        if (input.channel) where['channel'] = input.channel
        if (input.trengoChannelId != null) where['trengoChannelId'] = input.trengoChannelId
        // Multi-label (OR) takes precedence over the legacy single `tag`.
        if (input.tags && input.tags.length > 0) where['tags'] = { hasSome: input.tags }
        else if (input.tag) where['tags'] = { has: input.tag }
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
            lastMessagePreview: true,
            replyDeadlineAt: true,
            trengoChannelName: true,
            favorites: { where: { userId: user.id }, select: { conversationId: true } },
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
              },
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
          lastMessagePreview: r.lastMessagePreview,
          replyDeadlineAt: r.replyDeadlineAt,
          isFavorite: r.favorites.length > 0,
          trengoChannelName: r.trengoChannelName,
          contactName: r.contact
            ? [r.contact.firstName, r.contact.lastName]
                .filter((x): x is string => !!x)
                .join(' ') ||
              r.contact.email ||
              r.contact.phoneE164 ||
              null
            : null,
        }))
        const last = sliced[sliced.length - 1]
        const nextCursor =
          hasMore && last
            ? { id: last.id, lastMessageAt: last.lastMessageAt }
            : null
        return { items, nextCursor }
      }),

    /**
     * Whole-inbox search (Trengo parity). The list view only client-filters
     * the loaded page; this searches EVERY conversation head — by contact
     * name, the matched contact's email/phone, subject, last-message preview,
     * and labels — so a search finds conversations that aren't on the current
     * page. Returns the same item shape as `list` so the UI renders rows
     * identically.
     */
    search: protectedProcedure
      .input(z.object({ query: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(50).default(30) }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        const q = input.query
        const digits = q.replace(/\D/gu, '')
        const rows = await ctx.db.conversation.findMany({
          where: {
            OR: [
              { subject: { contains: q, mode: 'insensitive' } },
              { lastMessagePreview: { contains: q, mode: 'insensitive' } },
              { tags: { has: q } },
              {
                contact: {
                  OR: [
                    { firstName: { contains: q, mode: 'insensitive' } },
                    { lastName: { contains: q, mode: 'insensitive' } },
                    { email: { contains: q, mode: 'insensitive' } },
                    ...(digits.length >= 4
                      ? [{ phoneE164: { contains: digits } }]
                      : []),
                  ],
                },
              },
            ],
          },
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
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
            lastMessagePreview: true,
            replyDeadlineAt: true,
            contact: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
          },
        })
        const assigneeIds = Array.from(
          new Set(rows.map((r) => r.assigneeUserId).filter((id): id is string => !!id)),
        )
        const assignees = assigneeIds.length
          ? await ctx.db.user.findMany({
              where: { id: { in: assigneeIds } },
              select: { id: true, name: true, email: true },
            })
          : []
        const assigneeNameById = new Map(assignees.map((u) => [u.id, u.name ?? u.email] as const))
        const items = rows.map((r) => ({
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
          lastMessagePreview: r.lastMessagePreview,
          replyDeadlineAt: r.replyDeadlineAt,
          contactName: r.contact
            ? [r.contact.firstName, r.contact.lastName].filter((x): x is string => !!x).join(' ') ||
              r.contact.email ||
              null
            : null,
        }))
        return { items }
      }),

    /**
     * Distinct Trengo labels across conversation heads, ordered by how many
     * conversations carry each — drives the label filter in the comms-centre
     * rail. Bounded read (labels live on indexed head rows, not messages).
     */
    tags: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }
      const rows = await ctx.db.conversation.findMany({
        where: { tags: { isEmpty: false } },
        select: { tags: true },
        take: 5000,
      })
      const counts = new Map<string, number>()
      for (const r of rows) {
        for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
      // Also list the FULL Trengo label catalogue (best-effort, via the
      // caller's token) so every workspace label is a filter chip even before
      // it has been applied to a synced conversation ("not all labels are
      // here"). Catalogue-only labels get count 0; a missing/expired token
      // just falls back to the head-derived set.
      try {
        const { listTrengoLabels } = await import('@studymind/integration-trengo/outbound')
        const catalogue = await listTrengoLabels(user.id, ctx.requestId)
        for (const label of catalogue) {
          const name = label.name?.trim()
          if (name && !counts.has(name)) counts.set(name, 0)
        }
      } catch {
        // Best-effort only (no/expired token) — head-derived tags still return.
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 100)
        .map(([name, count]) => ({ name, count }))
    }),

    /** Folder counts for the rail (Trengo parity: "New 4 · Assigned 36"). */
    counts: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }
      const [newCount, assigned, mine, closed, snoozed, favorites, spam, mentionIds] =
        await Promise.all([
          ctx.db.conversation.count({ where: { status: 'open', assigneeUserId: null } }),
          ctx.db.conversation.count({
            where: { status: 'open', assigneeUserId: { not: null } },
          }),
          ctx.db.conversation.count({
            where: { status: { in: ['open', 'snoozed'] }, assigneeUserId: user.id },
          }),
          ctx.db.conversation.count({ where: { status: 'closed' } }),
          ctx.db.conversation.count({ where: { status: 'snoozed' } }),
          ctx.db.conversation.count({ where: { favorites: { some: { userId: user.id } } } }),
          ctx.db.conversation.count({ where: { status: 'spam' } }),
          mentionedConversationIds(ctx.db, user.id),
        ])
      return {
        newCount,
        assigned,
        mine,
        closed,
        snoozed,
        favorites,
        spam,
        mentioned: mentionIds.length,
      }
    }),

    // Trengo "Teams" folders — the teams the user can see, with a count of
    // open conversations assigned to each team's members. CEO/Senior Manager/
    // Manager see all teams; everyone else sees the teams they belong to.
    teams: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }
      const seesAll =
        user.role === 'ceo' || user.role === 'senior_manager' || user.role === 'manager'
      const teams = await ctx.db.team.findMany({
        where: {
          archivedAt: null,
          ...(seesAll ? {} : { members: { some: { userId: user.id } } }),
        },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          color: true,
          members: { select: { userId: true } },
        },
      })
      // One grouped count of open conversations by assignee across all the
      // member ids, then sum per team (a user can be on several teams).
      const allMemberIds = Array.from(
        new Set(teams.flatMap((t) => t.members.map((m) => m.userId))),
      )
      const grouped =
        allMemberIds.length > 0
          ? await ctx.db.conversation.groupBy({
              by: ['assigneeUserId'],
              where: { status: 'open', assigneeUserId: { in: allMemberIds } },
              _count: { _all: true },
            })
          : []
      const countByUser = new Map(
        grouped.map((g) => [g.assigneeUserId as string, g._count._all] as const),
      )
      return teams.map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        count: t.members.reduce((sum, m) => sum + (countByUser.get(m.userId) ?? 0), 0),
      }))
    }),

    // Trengo "Channels" — the workspace's individual named channels / "business
    // numbers" (Support Manager, Tutor Manager, info@, …) with a count of open
    // conversations on each. Built from the channel mirror AND the channels
    // actually in use on conversations, so it works even before a mirror sync.
    channels: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
      }
      const [mirror, convoChannels, grouped] = await Promise.all([
        ctx.db.trengoChannel.findMany({
          where: { isActive: true },
          select: { trengoId: true, name: true, channelType: true },
        }),
        ctx.db.conversation.findMany({
          where: { trengoChannelId: { not: null } },
          distinct: ['trengoChannelId'],
          select: { trengoChannelId: true, trengoChannelName: true, channel: true },
        }),
        ctx.db.conversation.groupBy({
          by: ['trengoChannelId'],
          where: { status: 'open', trengoChannelId: { not: null } },
          _count: { _all: true },
        }),
      ])
      const countById = new Map(
        grouped.map((g) => [g.trengoChannelId as number, g._count._all] as const),
      )
      const byId = new Map<
        number,
        { trengoId: number; name: string | null; channelType: string | null }
      >()
      for (const c of convoChannels) {
        if (c.trengoChannelId != null) {
          byId.set(c.trengoChannelId, {
            trengoId: c.trengoChannelId,
            name: c.trengoChannelName,
            channelType: c.channel,
          })
        }
      }
      for (const m of mirror) {
        const prev = byId.get(m.trengoId)
        byId.set(m.trengoId, {
          trengoId: m.trengoId,
          name: m.name ?? prev?.name ?? null,
          channelType: m.channelType ?? prev?.channelType ?? null,
        })
      }
      return [...byId.values()]
        .map((c) => ({ ...c, count: countById.get(c.trengoId) ?? 0 }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    }),

    // "Sync from Trengo" — force an immediate status re-sync of the recent
    // open conversations so anything closed/spam-boxed in Trengo converges now
    // instead of waiting for the round-robin reconcile cron. Sales Executive+
    // (it only READS Trengo + converges our own heads).
    syncNow: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!ALLOWED_ROLES.has(user.role) || user.role === 'virtual_assistant') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Sales Executive+ only.' })
      }
      const { inngest } = await import('@studymind/jobs')
      await inngest.send({ name: 'trengo/reconcile-now.requested', data: { by: user.id } })
      await ctx.audit({
        action: 'trengo.sync_now_requested',
        target: { type: 'Integration', id: 'trengo' },
        after: { by: user.id },
      })
      return { ok: true as const }
    }),

    // ADR 0020 Phase 6i — bulk triage actions on the conversation list.
    // markRead / snooze / unsnooze are fast head-only `updateMany`s; close
    // loops the audited Trengo outbound per conversation (capped, sequential)
    // so each close genuinely syncs to Trengo. Returns a per-action summary.
    bulk: auditedProcedure
      .input(
        z.object({
          conversationIds: z.array(z.string().min(1)).min(1).max(100),
          action: z.enum(['markRead', 'close', 'snooze', 'unsnooze', 'markSpam']),
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

        if (input.action === 'markSpam') {
          // CRM-side head status (Trengo Spam box parity). Like snooze, this
          // does not push to Trengo — Trengo owns its own spam classification.
          const r = await ctx.db.conversation.updateMany({
            where: { id: { in: ids }, status: { not: 'spam' } },
            data: { status: 'spam', snoozedUntil: null },
          })
          for (const id of ids) {
            publishConversationUpdate({ id, trengoTicketId: null, lastMessageAt: null, contactId: null })
          }
          await ctx.audit({
            action: 'trengo.conversation_marked_spam',
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

    // Personal Favorite (star) — per-user, idempotent toggle. No audit: this
    // is personal UI state (§20 audits Contact/finance/safeguarding writes).
    favorite: protectedProcedure
      .input(z.object({ conversationId: z.string().min(1), on: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        if (input.on) {
          await ctx.db.conversationFavorite.upsert({
            where: {
              userId_conversationId: {
                userId: user.id,
                conversationId: input.conversationId,
              },
            },
            create: { userId: user.id, conversationId: input.conversationId },
            update: {},
          })
        } else {
          await ctx.db.conversationFavorite.deleteMany({
            where: { userId: user.id, conversationId: input.conversationId },
          })
        }
        const { publishConversationUpdate } = await import('@studymind/core/realtime')
        publishConversationUpdate({
          id: input.conversationId,
          trengoTicketId: null,
          lastMessageAt: null,
          contactId: null,
        })
        return { conversationId: input.conversationId, isFavorite: input.on }
      }),

    // Mark-as-spam / restore (Trengo Spam box parity). CRM-side head status,
    // like snooze — Trengo keeps its own spam classification. Audited because
    // it changes conversation state (mirrors snooze/close).
    setSpam: auditedProcedure
      .input(z.object({ conversationId: z.string().min(1), spam: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        await ctx.db.conversation.update({
          where: { id: input.conversationId },
          data: input.spam
            ? { status: 'spam', snoozedUntil: null }
            : { status: 'open' },
        })
        const { publishConversationUpdate } = await import('@studymind/core/realtime')
        publishConversationUpdate({
          id: input.conversationId,
          trengoTicketId: null,
          lastMessageAt: null,
          contactId: null,
        })
        await ctx.audit({
          action: input.spam
            ? 'trengo.conversation_marked_spam'
            : 'trengo.conversation_unmarked_spam',
          target: { type: 'Conversation', id: input.conversationId },
          after: { spam: input.spam },
        })
        return { conversationId: input.conversationId, spam: input.spam }
      }),

    // Trengo-style right-pane context: contact "custom fields" + the contact's
    // OTHER conversations (Trengo's "Previous conversations" / linked tickets).
    context: protectedProcedure
      .input(z.object({ conversationId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        const head = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { id: true, contactId: true },
        })
        if (!head) throw new TRPCError({ code: 'NOT_FOUND' })
        if (!head.contactId) {
          return { contact: null, otherConversations: [] }
        }
        const [contact, others] = await Promise.all([
          ctx.db.contact.findUnique({
            where: { id: head.contactId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              phoneE164: true,
              country: true,
              referralSource: true,
              bookingStatus: true,
            },
          }),
          ctx.db.conversation.findMany({
            where: { contactId: head.contactId, id: { not: head.id } },
            orderBy: { lastMessageAt: 'desc' },
            take: 8,
            select: {
              id: true,
              channel: true,
              status: true,
              subject: true,
              lastMessageAt: true,
              lastMessagePreview: true,
            },
          }),
        ])
        return {
          contact: contact
            ? {
                id: contact.id,
                name:
                  [contact.firstName, contact.lastName].filter(Boolean).join(' ') ||
                  contact.email ||
                  contact.phoneE164 ||
                  null,
                email: contact.email,
                phone: contact.phoneE164,
                country: contact.country,
                referralSource: contact.referralSource,
                bookingStatus: contact.bookingStatus,
              }
            : null,
          otherConversations: others,
        }
      }),

    // Trengo "Views" — per-user saved filters surfaced as custom folders.
    views: router({
      list: protectedProcedure.query(async ({ ctx }) => {
        const user = requireUser(ctx)
        if (!ALLOWED_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
        }
        const rows = await ctx.db.conversationView.findMany({
          where: { ownerUserId: user.id },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { id: true, name: true, filter: true, channel: true, tag: true },
        })
        return rows
      }),
      create: protectedProcedure
        .input(
          z.object({
            name: z.string().trim().min(1).max(60),
            filter: z.enum([
              'active',
              'mine',
              'assigned',
              'unassigned',
              'snoozed',
              'closed',
              'mentioned',
              'favorites',
              'spam',
            ]),
            channel: z.enum(['whatsapp', 'sms', 'email', 'web_chat']).nullish(),
            tag: z.string().trim().min(1).max(80).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          if (!ALLOWED_ROLES.has(user.role)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
          }
          const count = await ctx.db.conversationView.count({
            where: { ownerUserId: user.id },
          })
          if (count >= 30) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'You have reached the maximum of 30 saved views.',
            })
          }
          const row = await ctx.db.conversationView.create({
            data: {
              id: createId(),
              ownerUserId: user.id,
              name: input.name,
              filter: input.filter,
              channel: input.channel ?? null,
              tag: input.tag ?? null,
              sortOrder: count,
            },
            select: { id: true, name: true, filter: true, channel: true, tag: true },
          })
          return row
        }),
      delete: protectedProcedure
        .input(z.object({ id: z.string().min(1) }))
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          if (!ALLOWED_ROLES.has(user.role)) {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'Inbox is staff-only.' })
          }
          // Owner-scoped delete — a user can only remove their own views.
          await ctx.db.conversationView.deleteMany({
            where: { id: input.id, ownerUserId: user.id },
          })
          return { id: input.id }
        }),
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
