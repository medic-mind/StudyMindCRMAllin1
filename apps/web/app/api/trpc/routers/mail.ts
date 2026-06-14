// /mail client data (ADR 0021 Phase 4). Email-focused views over the unified
// Conversation head (provider='email'). Staff-gated like the Comms Centre; the
// thread detail reuses `inbox.conversations.get` (it already renders email).
//
// `accounts` powers the folder rail / account filter and respects MailAccount
// visibility (own personal + shared the caller belongs to; Manager+ sees all),
// mirroring `mailAccount.list`. `threads.list` is the message list.

import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { applyMailToConversation, buildOutgoingEmail } from '@studymind/core/mail'
import { publishConversationUpdate } from '@studymind/core/realtime'
import { sendEmail, sendReply } from '@studymind/integration-gmail/outbound'

import { displayMessageBody } from '@/lib/format/html-text'
import { getMailSyncProvider } from '@/lib/mail/get-sync-provider'
import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type TrpcContext,
  type UserRole,
} from '@/lib/trpc/builders'

const STAFF_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const MANAGE_SHARED_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertStaff(role: UserRole): void {
  if (!STAFF_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Mail is staff-only.' })
  }
}

// Mutating the live mailbox (read/archive/star/trash/label) is a write —
// Virtual Assistant is read-only (§20). Sales Executive and above may act.
const MUTATE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])

function assertCanMutate(role: UserRole): void {
  if (!MUTATE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Virtual Assistant cannot change mail.',
    })
  }
}

interface EmailThreadRef {
  id: string
  externalThreadId: string
  mailAccountId: string
  contactId: string | null
  lastMessageAt: Date
  unreadCount: number
  status: string
}

/** Resolve an actionable email thread head, or throw a typed error. */
async function resolveEmailThread(
  ctx: TrpcContext,
  conversationId: string,
): Promise<EmailThreadRef> {
  const head = await ctx.db.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      provider: true,
      externalThreadId: true,
      mailAccountId: true,
      contactId: true,
      lastMessageAt: true,
      unreadCount: true,
      status: true,
    },
  })
  if (!head) throw new TRPCError({ code: 'NOT_FOUND' })
  if (head.provider !== 'email' || !head.externalThreadId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Not an email thread.' })
  }
  if (!head.mailAccountId) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        'Import this mailbox in Settings → Email accounts before acting on it.',
    })
  }
  return {
    id: head.id,
    externalThreadId: head.externalThreadId,
    mailAccountId: head.mailAccountId,
    contactId: head.contactId,
    lastMessageAt: head.lastMessageAt,
    unreadCount: head.unreadCount,
    status: head.status,
  }
}

export const mailRouter = router({
  /**
   * Email accounts visible to the caller, for the folder rail / account filter.
   * Same visibility as mailAccount.list: own personal + shared the caller
   * belongs to; Manager+ sees all. Only mail providers are returned.
   */
  accounts: protectedProcedure.query(async ({ ctx }) => {
    const me = requireUser(ctx)
    assertStaff(me.role)
    let where: Record<string, unknown> = { deletedAt: null }
    if (!MANAGE_SHARED_ROLES.has(me.role)) {
      const memberOf = await ctx.db.mailAccountMember.findMany({
        where: { userId: me.id },
        select: { mailAccountId: true },
      })
      where = {
        deletedAt: null,
        OR: [
          { ownerUserId: me.id },
          { id: { in: memberOf.map((m) => m.mailAccountId) } },
        ],
      }
    }
    const rows = await ctx.db.mailAccount.findMany({
      where,
      orderBy: [{ ownerKind: 'asc' }, { address: 'asc' }],
      select: {
        id: true,
        address: true,
        displayName: true,
        ownerKind: true,
        status: true,
        signatureHtml: true,
      },
    })
    return rows.map((r) => ({
      id: r.id,
      address: r.address,
      displayName: r.displayName,
      ownerKind: r.ownerKind,
      status: r.status,
      signatureHtml: r.signatureHtml,
    }))
  }),

  threads: router({
    /**
     * Email conversation heads, newest first. Optional account filter; an
     * `unread` filter for the unread folder. Keyset paginated on
     * (lastMessageAt, id) like the Comms Centre.
     */
    list: protectedProcedure
      .input(
        z.object({
          mailAccountId: z.string().nullish(),
          filter: z
            .enum(['all', 'unread', 'starred', 'archived', 'trash'])
            .default('all'),
          q: z.string().trim().min(1).max(120).nullish(),
          cursor: z
            .object({ id: z.string(), lastMessageAt: z.date() })
            .nullish(),
          limit: z.number().int().min(1).max(100).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)

        const where: Record<string, unknown> = { provider: 'email' }
        if (input.mailAccountId) where['mailAccountId'] = input.mailAccountId
        // Gmail-style folders. Trash is its own view; every other folder hides
        // trashed threads (Gmail's "All Mail" excludes Trash).
        switch (input.filter) {
          case 'unread':
            where['unreadCount'] = { gt: 0 }
            where['isTrashed'] = false
            break
          case 'starred':
            where['isStarred'] = true
            where['isTrashed'] = false
            break
          case 'archived':
            where['status'] = 'archived'
            where['isTrashed'] = false
            break
          case 'trash':
            where['isTrashed'] = true
            break
          default:
            where['isTrashed'] = false
        }
        // Compose cursor + search as AND clauses so neither clobbers the other.
        const and: unknown[] = []
        if (input.cursor) {
          and.push({
            OR: [
              { lastMessageAt: { lt: input.cursor.lastMessageAt } },
              {
                AND: [
                  { lastMessageAt: input.cursor.lastMessageAt },
                  { id: { lt: input.cursor.id } },
                ],
              },
            ],
          })
        }
        if (input.q) {
          const c = { contains: input.q, mode: 'insensitive' as const }
          and.push({
            OR: [
              { subject: c },
              { mailAccount: { is: { address: c } } },
              {
                contact: {
                  is: { OR: [{ firstName: c }, { lastName: c }, { email: c }] },
                },
              },
            ],
          })
        }
        if (and.length > 0) where['AND'] = and

        const rows = await ctx.db.conversation.findMany({
          where,
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            contactId: true,
            subject: true,
            unreadCount: true,
            status: true,
            isStarred: true,
            isTrashed: true,
            lastMessagePreview: true,
            lastSenderName: true,
            tags: true,
            lastMessageAt: true,
            mailAccountId: true,
            contact: {
              select: { id: true, firstName: true, lastName: true, email: true },
            },
            mailAccount: { select: { address: true } },
          },
        })

        const hasMore = rows.length > input.limit
        const sliced = hasMore ? rows.slice(0, input.limit) : rows
        const items = sliced.map((r) => {
          const contactName = r.contact
            ? [r.contact.firstName, r.contact.lastName]
                .filter((x): x is string => !!x)
                .join(' ') ||
              r.contact.email ||
              null
            : null
          return {
            id: r.id,
            contactId: r.contactId,
            subject: r.subject,
            unreadCount: r.unreadCount,
            status: r.status,
            isStarred: r.isStarred,
            isTrashed: r.isTrashed,
            preview: r.lastMessagePreview,
            labels: r.tags,
            lastMessageAt: r.lastMessageAt,
            accountAddress: r.mailAccount?.address ?? null,
            // Gmail shows the actual sender; the matched CRM contact is the
            // fallback (and the email address as a last resort).
            contactName: r.lastSenderName ?? contactName,
          }
        })
        const last = sliced[sliced.length - 1]
        const nextCursor =
          hasMore && last
            ? { id: last.id, lastMessageAt: last.lastMessageAt }
            : null
        return { items, nextCursor }
      }),
  }),

  // ADR 0021 Phase 4 — compose a brand-new email from the CRM. Sends from the
  // chosen account's mailbox via the Gmail outbound, links matched Contacts,
  // and creates the email Conversation head so the new thread shows in /mail
  // immediately. Sales Executive+ (VA read-only). Gmail today; other providers
  // arrive with Phase 7.
  compose: auditedProcedure
    .input(
      z.object({
        mailAccountId: z.string(),
        to: z.array(z.string().trim().email()).min(1).max(50),
        cc: z.array(z.string().trim().email()).max(50).optional(),
        subject: z.string().trim().min(1).max(500),
        body: z.string().trim().min(1).max(50_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      assertCanMutate(me.role)
      const account = await ctx.db.mailAccount.findFirst({
        where: { id: input.mailAccountId, deletedAt: null },
        select: {
          id: true,
          provider: true,
          ownerUserId: true,
          address: true,
          status: true,
          signatureHtml: true,
        },
      })
      if (!account) throw new TRPCError({ code: 'NOT_FOUND' })
      if (account.provider !== 'gmail') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Composing is only available on Gmail accounts today.',
        })
      }
      if (!account.ownerUserId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This mailbox has no connected owner to send as.',
        })
      }

      // multipart/alternative so the new email renders rich (Gmail-identical)
      // with the account's copied HTML signature.
      const bodies = buildOutgoingEmail({
        body: input.body,
        signatureHtml: account.signatureHtml,
        signatureText: account.signatureHtml
          ? displayMessageBody(account.signatureHtml)
          : null,
      })
      const result = await sendEmail({
        agentId: account.ownerUserId,
        fromAddress: account.address,
        subject: input.subject,
        body: bodies.text,
        html: bodies.html,
        toAddresses: input.to,
        cc: input.cc,
        requestId: ctx.requestId,
      })

      // Create the email Conversation head for the new thread so it appears in
      // the unified inbox without waiting for the next Gmail sync.
      if (result.gmailThreadId) {
        await applyMailToConversation(ctx.db, {
          provider: 'email',
          externalThreadId: result.gmailThreadId,
          mailAccountId: account.id,
          direction: 'sent',
          occurredAt: new Date(),
          contactId: null,
          familyId: null,
          subject: input.subject,
        })
      }

      await ctx.audit({
        action: 'mail.composed',
        target: { type: 'MailAccount', id: account.id },
        after: { to: input.to, cc: input.cc ?? [], threadId: result.gmailThreadId },
      })
      return { id: account.id, threadId: result.gmailThreadId }
    }),

  // ADR 0021 Phase 5 — two-way action sync. Each mutation performs the action
  // on the live mailbox via the provider seam, then reflects it on the
  // Conversation head and audits. All idempotent + reversible (trash → Gmail
  // Trash). Sales Executive and above (VA is read-only).
  thread: router({
    /** The account's labels/folders, for the label picker. */
    labels: protectedProcedure
      .input(z.object({ conversationId: z.string() }))
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.labels',
        })
        const labels = await provider.listLabels()
        // Hide Gmail system labels the UI exposes as first-class actions.
        const SYSTEM = new Set([
          'INBOX',
          'UNREAD',
          'STARRED',
          'TRASH',
          'SENT',
          'DRAFT',
          'SPAM',
          'CHAT',
        ])
        return labels.filter((l) => !SYSTEM.has(l.id))
      }),

    setRead: auditedProcedure
      .input(z.object({ conversationId: z.string(), read: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.set_read',
        })
        await provider.setReadState(head.externalThreadId, input.read)
        await ctx.db.conversation.update({
          where: { id: head.id },
          data: { unreadCount: input.read ? 0 : Math.max(1, head.unreadCount) },
        })
        publishConversationUpdate({
          id: head.id,
          trengoTicketId: null,
          lastMessageAt: head.lastMessageAt.toISOString(),
          contactId: head.contactId,
        })
        await ctx.audit({
          action: 'mail.thread_read_changed',
          target: { type: 'Conversation', id: head.id },
          after: { read: input.read },
        })
        return { id: head.id }
      }),

    setArchived: auditedProcedure
      .input(z.object({ conversationId: z.string(), archived: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.set_archived',
        })
        await provider.setArchived(head.externalThreadId, input.archived)
        await ctx.db.conversation.update({
          where: { id: head.id },
          data: { status: input.archived ? 'archived' : 'open' },
        })
        publishConversationUpdate({
          id: head.id,
          trengoTicketId: null,
          lastMessageAt: head.lastMessageAt.toISOString(),
          contactId: head.contactId,
        })
        await ctx.audit({
          action: 'mail.thread_archived',
          target: { type: 'Conversation', id: head.id },
          after: { archived: input.archived },
        })
        return { id: head.id }
      }),

    setStarred: auditedProcedure
      .input(z.object({ conversationId: z.string(), starred: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.set_starred',
        })
        await provider.setStarred(head.externalThreadId, input.starred)
        await ctx.db.conversation.update({
          where: { id: head.id },
          data: { isStarred: input.starred },
        })
        publishConversationUpdate({
          id: head.id,
          trengoTicketId: null,
          lastMessageAt: head.lastMessageAt.toISOString(),
          contactId: head.contactId,
        })
        await ctx.audit({
          action: 'mail.thread_starred',
          target: { type: 'Conversation', id: head.id },
          after: { starred: input.starred },
        })
        return { id: head.id }
      }),

    setTrashed: auditedProcedure
      .input(z.object({ conversationId: z.string(), trashed: z.boolean() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.set_trashed',
        })
        // Reversible: Gmail keeps trashed threads recoverable for 30 days.
        await provider.setTrashed(head.externalThreadId, input.trashed)
        await ctx.db.conversation.update({
          where: { id: head.id },
          data: { status: input.trashed ? 'archived' : 'open', isTrashed: input.trashed },
        })
        publishConversationUpdate({
          id: head.id,
          trengoTicketId: null,
          lastMessageAt: head.lastMessageAt.toISOString(),
          contactId: head.contactId,
        })
        await ctx.audit({
          action: 'mail.thread_trashed',
          target: { type: 'Conversation', id: head.id },
          after: { trashed: input.trashed },
        })
        return { id: head.id }
      }),

    /**
     * Reply to an email thread from the CRM. Reuses the Gmail `sendReply`
     * outbound (idempotent on (threadId, requestId)); it writes the
     * `email_sent` Interaction + audits `gmail.email_sent`. We additionally
     * reflect the outbound on the head and audit `mail.thread_replied`.
     */
    reply: auditedProcedure
      .input(
        z.object({
          conversationId: z.string(),
          body: z.string().trim().min(1).max(50_000),
          cc: z.array(z.string().email()).max(50).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)

        const account = await ctx.db.mailAccount.findUnique({
          where: { id: head.mailAccountId },
          select: { ownerUserId: true, signatureHtml: true },
        })
        if (!account?.ownerUserId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This mailbox has no connected owner to send as.',
          })
        }

        // Latest inbound message on the thread gives us who to reply to, the
        // subject, and the Message-ID to thread against.
        const latestInbound = await ctx.db.interaction.findFirst({
          where: {
            deletedAt: null,
            type: 'email_received',
            payload: { path: ['gmailThreadId'], equals: head.externalThreadId },
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          select: { payload: true },
        })
        const p = (latestInbound?.payload as Record<string, unknown> | null) ?? {}
        const from = Array.isArray(p['from']) ? (p['from'] as string[]) : []
        const toAddresses = from.filter((a) => typeof a === 'string' && a.length > 0)
        if (toAddresses.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No inbound message to reply to on this thread yet.',
          })
        }
        const subject = typeof p['subject'] === 'string' ? (p['subject'] as string) : ''
        const originalMessageId =
          typeof p['messageIdHeader'] === 'string'
            ? (p['messageIdHeader'] as string)
            : undefined

        // Send as multipart/alternative so the message renders like Gmail and
        // the account's copied HTML signature shows with its real formatting.
        const bodies = buildOutgoingEmail({
          body: input.body,
          signatureHtml: account.signatureHtml,
          signatureText: account.signatureHtml
            ? displayMessageBody(account.signatureHtml)
            : null,
        })
        await sendReply({
          agentId: account.ownerUserId,
          threadId: head.externalThreadId,
          subject,
          body: bodies.text,
          html: bodies.html,
          toAddresses,
          cc: input.cc,
          requestId: ctx.requestId,
          originalMessageId,
        })

        const now = new Date()
        await ctx.db.conversation.update({
          where: { id: head.id },
          data: { lastOutboundAt: now, lastMessageAt: now, unreadCount: 0, status: 'open' },
        })
        publishConversationUpdate({
          id: head.id,
          trengoTicketId: null,
          lastMessageAt: now.toISOString(),
          contactId: head.contactId,
        })
        await ctx.audit({
          action: 'mail.thread_replied',
          target: { type: 'Conversation', id: head.id },
          after: { to: toAddresses, cc: input.cc ?? [] },
        })
        return { id: head.id }
      }),

    setLabels: auditedProcedure
      .input(
        z.object({
          conversationId: z.string(),
          add: z.array(z.string()).max(50).optional(),
          remove: z.array(z.string()).max(50).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        if (!input.add?.length && !input.remove?.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Provide labels to add or remove.',
          })
        }
        const head = await resolveEmailThread(ctx, input.conversationId)
        const provider = await getMailSyncProvider({
          accountId: head.mailAccountId,
          requestId: ctx.requestId,
          purpose: 'mail.set_labels',
        })
        await provider.modifyLabels(head.externalThreadId, {
          ...(input.add ? { add: input.add } : {}),
          ...(input.remove ? { remove: input.remove } : {}),
        })
        await ctx.audit({
          action: 'mail.thread_labeled',
          target: { type: 'Conversation', id: head.id },
          after: { add: input.add ?? [], remove: input.remove ?? [] },
        })
        return { id: head.id }
      }),
  }),
})
