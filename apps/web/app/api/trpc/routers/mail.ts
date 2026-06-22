// /mail client data (ADR 0021 Phase 4). Email-focused views over the unified
// Conversation head (provider='email'). Staff-gated like the Comms Centre; the
// thread detail reuses `inbox.conversations.get` (it already renders email).
//
// `accounts` powers the folder rail / account filter and respects MailAccount
// visibility (own personal + shared the caller belongs to; Manager+ sees all),
// mirroring `mailAccount.list`. `threads.list` is the message list.

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { createId } from '@paralleldrive/cuid2'

import {
  applyMailToConversation,
  buildForwardQuote,
  buildOutgoingEmail,
  buildReplyQuote,
  computeReplyAllRecipients,
  forwardSubject,
  normaliseEmail,
  replySubject,
} from '@studymind/core/mail'
import { publishConversationUpdate } from '@studymind/core/realtime'
import { sendEmail, sendReply, saveDraft, sendDraftMessage, type OutboundAttachment } from '@studymind/integration-gmail/outbound'
import { getAttachment } from '@studymind/integration-gmail/s3'
import {
  createClientForAgent,
  getHeader,
  parseAddresses,
} from '@studymind/integration-gmail/client'

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
  let mailAccountId = head.mailAccountId
  if (!mailAccountId) {
    // Heads synced via the legacy Gmail connect have no MailAccount bridge yet,
    // which used to make every action button fail. Self-heal: resolve (or create)
    // the MailAccount for the owning Gmail mailbox and stamp the head, so actions
    // just work without a manual "import" step.
    const me = requireUser(ctx)
    mailAccountId = await ensureMailAccountForThread(
      ctx,
      head.externalThreadId,
      head.id,
      me.id,
    )
    if (!mailAccountId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'No connected Gmail mailbox found for this thread — reconnect Gmail in Settings → Mailbox.',
      })
    }
  }
  return {
    id: head.id,
    externalThreadId: head.externalThreadId,
    mailAccountId,
    contactId: head.contactId,
    lastMessageAt: head.lastMessageAt,
    unreadCount: head.unreadCount,
    status: head.status,
  }
}

/**
 * Resolve (or create) the MailAccount bridging the Gmail mailbox that owns a
 * thread, and stamp it onto the head. Used to self-heal heads that were synced
 * before a MailAccount existed, so action buttons work without a manual import.
 * Returns null when no connected Gmail mailbox can be matched.
 */
async function ensureMailAccountForThread(
  ctx: TrpcContext,
  threadId: string,
  headId: string,
  actorId: string,
): Promise<string | null> {
  // Addresses on the thread tell us which connected mailbox synced it.
  const interaction = await ctx.db.interaction.findFirst({
    where: {
      type: { in: ['email_received', 'email_sent'] },
      payload: { path: ['gmailThreadId'], equals: threadId },
    },
    select: { payload: true },
  })
  const addrs = new Set<string>()
  const p = (interaction?.payload ?? {}) as Record<string, unknown>
  for (const key of ['from', 'to', 'cc', 'bcc'] as const) {
    const v = p[key]
    if (Array.isArray(v)) for (const a of v) if (typeof a === 'string') addrs.add(a.toLowerCase())
  }
  let mailbox =
    addrs.size > 0
      ? await ctx.db.gmailMailbox.findFirst({
          where: { deletedAt: null, address: { in: [...addrs] } },
          select: { id: true, agentId: true, address: true, isDefault: true },
        })
      : null
  // Fallback: the acting user's own (default) connected mailbox.
  if (!mailbox) {
    mailbox = await ctx.db.gmailMailbox.findFirst({
      where: { agentId: actorId, deletedAt: null },
      orderBy: { isDefault: 'desc' },
      select: { id: true, agentId: true, address: true, isDefault: true },
    })
  }
  if (!mailbox) return null

  const address = normaliseEmail(mailbox.address)
  let account = await ctx.db.mailAccount.findUnique({
    where: { gmailMailboxId: mailbox.id },
    select: { id: true },
  })
  if (!account) {
    const byAddress = await ctx.db.mailAccount.findUnique({
      where: { address },
      select: { id: true },
    })
    if (byAddress) {
      await ctx.db.mailAccount.update({
        where: { id: byAddress.id },
        data: {
          gmailMailboxId: mailbox.id,
          provider: 'gmail',
          ownerKind: 'personal',
          ownerUserId: mailbox.agentId,
          status: 'connected',
          deletedAt: null,
          updatedById: actorId,
        },
      })
      account = byAddress
    } else {
      account = await ctx.db.mailAccount.create({
        data: {
          id: createId(),
          provider: 'gmail',
          ownerKind: 'personal',
          ownerUserId: mailbox.agentId,
          address,
          status: 'connected',
          isDefault: mailbox.isDefault,
          gmailMailboxId: mailbox.id,
          createdById: actorId,
          updatedById: actorId,
        },
        select: { id: true },
      })
    }
  }
  await ctx.db.conversation.update({
    where: { id: headId },
    data: { mailAccountId: account.id },
  })
  return account.id
}

interface ThreadMessageContext {
  from: string[]
  to: string[]
  cc: string[]
  subject: string | null
  messageId: string | undefined
  date: Date | null
  senderName: string | null
  text: string | null
  html: string | null
  attachments: Array<{ s3Key: string; filename: string; contentType: string }>
}

/** Load the latest message on a thread (optionally inbound-only) and shape the
 *  fields reply/reply-all/forward need: addresses, subject, threading id, body,
 *  and stored attachment keys. */
async function loadThreadMessageContext(
  ctx: TrpcContext,
  externalThreadId: string,
  opts: { inboundOnly: boolean },
): Promise<ThreadMessageContext | null> {
  const row = await ctx.db.interaction.findFirst({
    where: {
      deletedAt: null,
      type: opts.inboundOnly ? 'email_received' : { in: ['email_received', 'email_sent'] },
      payload: { path: ['gmailThreadId'], equals: externalThreadId },
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    select: { occurredAt: true, payload: true },
  })
  if (!row) return null
  const p = (row.payload ?? {}) as Record<string, unknown>
  const arr = (k: string): string[] =>
    Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const rawAtts = Array.isArray(p['attachments'])
    ? (p['attachments'] as Array<Record<string, unknown>>)
    : []
  return {
    from: arr('from'),
    to: arr('to'),
    cc: arr('cc'),
    subject: typeof p['subject'] === 'string' ? (p['subject'] as string) : null,
    messageId: typeof p['messageIdHeader'] === 'string' ? (p['messageIdHeader'] as string) : undefined,
    date: row.occurredAt ?? null,
    senderName: typeof p['senderName'] === 'string' ? (p['senderName'] as string) : null,
    text: typeof p['body'] === 'string' ? (p['body'] as string) : null,
    html: typeof p['bodyHtml'] === 'string' ? (p['bodyHtml'] as string) : null,
    attachments: rawAtts
      .map((a) => ({
        s3Key: typeof a['s3Key'] === 'string' ? (a['s3Key'] as string) : '',
        filename: typeof a['filename'] === 'string' ? (a['filename'] as string) : 'attachment',
        contentType: typeof a['mimeType'] === 'string' ? (a['mimeType'] as string) : 'application/octet-stream',
      }))
      .filter((a) => a.s3Key.length > 0),
  }
}

/** Resolve a Gmail MailAccount to its owning agent + address for outbound /
 *  draft operations. Throws when it's missing, non-Gmail, or owner-less. */
async function resolveGmailAccount(
  ctx: TrpcContext,
  mailAccountId: string,
): Promise<{ ownerUserId: string; address: string }> {
  const acc = await ctx.db.mailAccount.findFirst({
    where: { id: mailAccountId, deletedAt: null },
    select: { provider: true, ownerUserId: true, address: true },
  })
  if (!acc) throw new TRPCError({ code: 'NOT_FOUND', message: 'Mail account not found' })
  if (acc.provider !== 'gmail') {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Drafts are Gmail-only today.' })
  }
  if (!acc.ownerUserId) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'This mailbox has no connected owner.' })
  }
  return { ownerUserId: acc.ownerUserId, address: acc.address }
}

/** Our own addresses for this account (mailbox address + send-as aliases), used
 *  to exclude ourselves from reply-all recipients. */
async function selfAddressesForAccount(ctx: TrpcContext, mailAccountId: string): Promise<string[]> {
  const acc = await ctx.db.mailAccount.findUnique({
    where: { id: mailAccountId },
    select: { address: true },
  })
  return acc?.address ? [acc.address.toLowerCase()] : []
}

/** Forwarded attachments can be large; cap total re-attached bytes (Gmail's own
 *  message ceiling is 25 MB) so a forward can't exhaust memory. */
const MAX_FORWARD_ATTACH_BYTES = 25 * 1024 * 1024

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Shared select for the email-head list rows (threads.list + search). */
const MAIL_HEAD_SELECT = {
  id: true,
  contactId: true,
  externalThreadId: true,
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
  contact: { select: { id: true, firstName: true, lastName: true, email: true } },
  mailAccount: { select: { address: true } },
} as const

interface MailHeadRow {
  id: string
  contactId: string | null
  externalThreadId: string | null
  subject: string | null
  unreadCount: number
  status: string
  isStarred: boolean
  isTrashed: boolean
  lastMessagePreview: string | null
  lastSenderName: string | null
  tags: string[]
  lastMessageAt: Date
  mailAccountId: string | null
  contact: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null
  mailAccount: { address: string } | null
}

/** Shape email-head rows into list items, repairing the sender name for legacy
 *  heads (null `lastSenderName`) from their latest inbound message in ONE bounded
 *  query. Shared by threads.list and search so both render identically. */
async function shapeMailHeadItems(ctx: TrpcContext, rows: MailHeadRow[]) {
  const needSender = rows.filter((r) => !r.lastSenderName && r.externalThreadId)
  const senderByThread = new Map<string, string>()
  if (needSender.length > 0) {
    const threadIds = needSender.map((r) => r.externalThreadId as string)
    const ints = await ctx.db.interaction.findMany({
      where: {
        type: 'email_received',
        deletedAt: null,
        OR: threadIds.map((t) => ({ payload: { path: ['gmailThreadId'], equals: t } })),
      },
      orderBy: { occurredAt: 'desc' },
      take: 400,
      select: { payload: true },
    })
    for (const it of ints) {
      const p = (it.payload ?? {}) as { gmailThreadId?: unknown; senderName?: unknown; from?: unknown }
      const tid = typeof p.gmailThreadId === 'string' ? p.gmailThreadId : null
      if (!tid || senderByThread.has(tid)) continue
      const fromName =
        typeof p.senderName === 'string' && p.senderName.trim() !== ''
          ? p.senderName
          : Array.isArray(p.from) && typeof p.from[0] === 'string'
            ? (p.from[0] as string)
            : null
      if (fromName) senderByThread.set(tid, fromName)
    }
  }
  return rows.map((r) => {
    const contactName = r.contact
      ? [r.contact.firstName, r.contact.lastName].filter((x): x is string => !!x).join(' ') ||
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
      contactName:
        r.lastSenderName ??
        (r.externalThreadId ? senderByThread.get(r.externalThreadId) : null) ??
        contactName,
    }
  })
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

  /**
   * Distinct Gmail labels across the visible email heads, with a thread count —
   * the rail's label folders (Gmail's label sidebar). Reads `Conversation.tags`
   * (populated by the sync + resync). Excludes trashed threads.
   */
  labels: protectedProcedure
    .input(z.object({ mailAccountId: z.string().nullish() }).default({}))
    .query(async ({ ctx, input }) => {
      const me = requireUser(ctx)
      assertStaff(me.role)
      const rows = await ctx.db.conversation.findMany({
        where: {
          provider: 'email',
          isTrashed: false,
          ...(input.mailAccountId ? { mailAccountId: input.mailAccountId } : {}),
          NOT: { tags: { isEmpty: true } },
        },
        select: { tags: true },
        // Bounded scan — labels stabilise quickly; this is for the rail, not a
        // per-thread read.
        take: 5000,
      })
      const counts = new Map<string, number>()
      for (const r of rows) {
        for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
      }
      return Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name))
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
            .enum(['inbox', 'all', 'unread', 'starred', 'archived', 'trash'])
            .default('inbox'),
          /** Filter to one Gmail label (the rail's label folders). Spans all
           *  non-trash mail, like clicking a label in Gmail. */
          label: z.string().trim().min(1).max(200).nullish(),
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
          case 'inbox':
            // Gmail's Inbox: not archived, not trashed. (`all` is All Mail.)
            where['status'] = 'open'
            where['isTrashed'] = false
            break
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
        // Label folder: narrow to threads carrying this Gmail label (chips live
        // on Conversation.tags). Additive to the selected folder.
        if (input.label) where['tags'] = { has: input.label }
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
        // A typed query routes through Gmail search (mail.search) — this folder
        // list stays a fast keyset browse of synced heads (no local substring
        // search, which never matched the body anyway).
        if (and.length > 0) where['AND'] = and

        const rows = (await ctx.db.conversation.findMany({
          where,
          orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: MAIL_HEAD_SELECT,
        })) as MailHeadRow[]

        const hasMore = rows.length > input.limit
        const sliced = hasMore ? rows.slice(0, input.limit) : rows
        const items = await shapeMailHeadItems(ctx, sliced)
        const last = sliced[sliced.length - 1]
        const nextCursor =
          hasMore && last ? { id: last.id, lastMessageAt: last.lastMessageAt } : null
        return { items, nextCursor }
      }),

    /**
     * Full Gmail search (E1/E2): the query is passed straight to Gmail's `q`, so
     * full-body matching and every operator (from:/to:/subject:/has:attachment/
     * is:unread/before:/OR/grouping/…) work natively. Gmail returns thread ids
     * in relevance order; we map them to our synced Conversation heads and shape
     * them identically to the list. Paginated via Gmail's pageToken.
     */
    search: protectedProcedure
      .input(
        z.object({
          mailAccountId: z.string(),
          q: z.string().trim().min(1).max(500),
          pageToken: z.string().optional(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const client = await createClientForAgent({
          agentId: acc.ownerUserId,
          address: acc.address,
          purpose: 'gmail.search',
          requestId: ctx.requestId,
        })
        const { threadIds, nextPageToken } = await client.searchThreadIds({
          q: input.q,
          ...(input.pageToken ? { pageToken: input.pageToken } : {}),
          maxResults: 30,
        })
        if (threadIds.length === 0) {
          return { items: [] as Awaited<ReturnType<typeof shapeMailHeadItems>>, nextPageToken }
        }
        const rows = (await ctx.db.conversation.findMany({
          where: {
            provider: 'email',
            mailAccountId: input.mailAccountId,
            externalThreadId: { in: threadIds },
          },
          select: MAIL_HEAD_SELECT,
        })) as MailHeadRow[]
        // Preserve Gmail's relevance order.
        const order = new Map(threadIds.map((t, i) => [t, i]))
        rows.sort(
          (a, b) =>
            (order.get(a.externalThreadId ?? '') ?? 1e9) -
            (order.get(b.externalThreadId ?? '') ?? 1e9),
        )
        const items = await shapeMailHeadItems(ctx, rows)
        return { items, nextPageToken }
      }),
  }),

  // ADR 0021 Phase 4 — compose a brand-new email from the CRM. Sends from the
  // chosen account's mailbox via the Gmail outbound, links matched Contacts,
  // and creates the email Conversation head so the new thread shows in /mail
  // immediately. Sales Executive+ (VA read-only). Gmail today; other providers
  // arrive with Phase 7.
  // Drafts (G1–G3). Gmail-backed (drafts.*) so they appear in Gmail too and a
  // draft→send never duplicates. Auto-save calls `save` (create then update).
  drafts: router({
    list: protectedProcedure
      .input(z.object({ mailAccountId: z.string() }))
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const client = await createClientForAgent({
          agentId: acc.ownerUserId,
          address: acc.address,
          purpose: 'gmail.drafts_list',
          requestId: ctx.requestId,
        })
        const stubs = await client.listDrafts({ maxResults: 50 })
        // Fetch each draft's headers/snippet (drafts are few; bounded at 50).
        const items = await Promise.all(
          stubs.map(async (s) => {
            try {
              const d = await client.getDraft(s.draftId)
              const subject = getHeader(d.message.headers, 'Subject')
              const to = parseAddresses(getHeader(d.message.headers, 'To'))
              return {
                draftId: s.draftId,
                subject: subject && subject.length > 0 ? subject : '(no subject)',
                to,
                snippet: (d.message.body ?? '').slice(0, 140),
                date: d.message.internalDate ? new Date(d.message.internalDate) : null,
              }
            } catch {
              return { draftId: s.draftId, subject: '(draft)', to: [], snippet: '', date: null }
            }
          }),
        )
        items.sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0))
        return { items }
      }),

    get: protectedProcedure
      .input(z.object({ mailAccountId: z.string(), draftId: z.string() }))
      .query(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertStaff(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const client = await createClientForAgent({
          agentId: acc.ownerUserId,
          address: acc.address,
          purpose: 'gmail.drafts_get',
          requestId: ctx.requestId,
        })
        const d = await client.getDraft(input.draftId)
        return {
          draftId: d.draftId,
          subject: getHeader(d.message.headers, 'Subject') ?? '',
          to: parseAddresses(getHeader(d.message.headers, 'To')),
          cc: parseAddresses(getHeader(d.message.headers, 'Cc')),
          bcc: parseAddresses(getHeader(d.message.headers, 'Bcc')),
          body: d.message.body ?? '',
        }
      }),

    /** Create or update a draft (auto-save). Returns the draft id to update on
     *  subsequent saves. */
    save: auditedProcedure
      .input(
        z.object({
          mailAccountId: z.string(),
          draftId: z.string().optional(),
          to: z.array(z.string().trim()).max(50).default([]),
          cc: z.array(z.string().trim()).max(50).optional(),
          bcc: z.array(z.string().trim()).max(50).optional(),
          subject: z.string().max(500).default(''),
          body: z.string().max(50_000).default(''),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const bodies = buildOutgoingEmail({ body: input.body })
        const res = await saveDraft({
          agentId: acc.ownerUserId,
          fromAddress: acc.address,
          draftId: input.draftId,
          subject: input.subject,
          body: bodies.text,
          html: bodies.html,
          toAddresses: input.to.filter((a) => a.length > 0),
          cc: input.cc,
          bcc: input.bcc,
          requestId: ctx.requestId,
        })
        ctx.audit.called = true
        return { draftId: res.draftId }
      }),

    /** Send a draft (drafts.send — no duplicate). Links contacts + audits. */
    send: auditedProcedure
      .input(
        z.object({
          mailAccountId: z.string(),
          draftId: z.string(),
          to: z.array(z.string().trim().email()).min(1).max(50),
          cc: z.array(z.string().trim().email()).max(50).optional(),
          bcc: z.array(z.string().trim().email()).max(50).optional(),
          subject: z.string().trim().max(500).default(''),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const result = await sendDraftMessage({
          agentId: acc.ownerUserId,
          fromAddress: acc.address,
          draftId: input.draftId,
          subject: input.subject,
          toAddresses: input.to,
          cc: input.cc,
          bcc: input.bcc,
          requestId: ctx.requestId,
        })
        if (result.gmailThreadId) {
          await applyMailToConversation(ctx.db, {
            provider: 'email',
            externalThreadId: result.gmailThreadId,
            mailAccountId: input.mailAccountId,
            direction: 'sent',
            occurredAt: new Date(),
            contactId: null,
            familyId: null,
            subject: input.subject || null,
            senderName: null,
          })
        }
        await ctx.audit({
          action: 'mail.draft_sent',
          target: { type: 'MailAccount', id: input.mailAccountId },
          after: { to: input.to, threadId: result.gmailThreadId },
        })
        return { threadId: result.gmailThreadId }
      }),

    delete: auditedProcedure
      .input(z.object({ mailAccountId: z.string(), draftId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const acc = await resolveGmailAccount(ctx, input.mailAccountId)
        const client = await createClientForAgent({
          agentId: acc.ownerUserId,
          address: acc.address,
          purpose: 'gmail.drafts_delete',
          requestId: ctx.requestId,
        })
        await client.deleteDraft(input.draftId)
        await ctx.audit({
          action: 'mail.draft_deleted',
          target: { type: 'MailAccount', id: input.mailAccountId },
          after: { draftId: input.draftId },
        })
        return { ok: true as const }
      }),
  }),

  compose: auditedProcedure
    .input(
      z.object({
        mailAccountId: z.string(),
        to: z.array(z.string().trim().email()).min(1).max(50),
        cc: z.array(z.string().trim().email()).max(50).optional(),
        bcc: z.array(z.string().trim().email()).max(50).optional(),
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
        bcc: input.bcc,
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
          bcc: z.array(z.string().email()).max(50).optional(),
          /** Reply to everyone (sender + original To/Cc, minus us). */
          replyAll: z.boolean().optional(),
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

        // Latest inbound message: who to reply to, the subject, the Message-ID
        // to thread against, and the body to quote.
        const msg = await loadThreadMessageContext(ctx, head.externalThreadId, {
          inboundOnly: true,
        })
        if (!msg || msg.from.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No inbound message to reply to on this thread yet.',
          })
        }

        // Reply → sender only; Reply all → + original To/Cc minus us.
        const self = await selfAddressesForAccount(ctx, head.mailAccountId)
        let toAddresses: string[]
        let cc: string[] | undefined = input.cc
        if (input.replyAll) {
          const r = computeReplyAllRecipients({ from: msg.from, to: msg.to, cc: msg.cc, self })
          toAddresses = r.to
          cc = [...new Set([...(input.cc ?? []), ...r.cc])]
        } else {
          toAddresses = [msg.from[0]!]
        }
        if (toAddresses.length === 0) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'No recipient to reply to.' })
        }

        // Quote the original beneath the reply (Gmail behaviour).
        const quote = buildReplyQuote({
          date: msg.date,
          fromName: msg.senderName,
          fromEmail: msg.from[0] ?? null,
          text: msg.text,
          html: msg.html,
        })
        const bodies = buildOutgoingEmail({
          body: input.body,
          signatureHtml: account.signatureHtml,
          signatureText: account.signatureHtml ? displayMessageBody(account.signatureHtml) : null,
          quotedText: quote.text,
          quotedHtml: quote.html,
        })
        await sendReply({
          agentId: account.ownerUserId,
          threadId: head.externalThreadId,
          subject: replySubject(msg.subject),
          body: bodies.text,
          html: bodies.html,
          toAddresses,
          cc,
          bcc: input.bcc,
          requestId: ctx.requestId,
          originalMessageId: msg.messageId,
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
          after: { to: toAddresses, cc: cc ?? [], replyAll: Boolean(input.replyAll) },
        })
        return { id: head.id }
      }),

    /**
     * Forward the thread's latest message to new recipients as a NEW Gmail
     * thread (Fwd: subject), with the original quoted in Gmail's "Forwarded
     * message" block and the original attachments re-attached from S3. Sales
     * Executive+; Gmail today.
     */
    forward: auditedProcedure
      .input(
        z.object({
          conversationId: z.string(),
          to: z.array(z.string().email()).min(1).max(50),
          cc: z.array(z.string().email()).max(50).optional(),
          bcc: z.array(z.string().email()).max(50).optional(),
          body: z.string().trim().max(50_000).default(''),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const me = requireUser(ctx)
        assertCanMutate(me.role)
        const head = await resolveEmailThread(ctx, input.conversationId)
        const account = await ctx.db.mailAccount.findUnique({
          where: { id: head.mailAccountId },
          select: { ownerUserId: true, address: true, signatureHtml: true },
        })
        if (!account?.ownerUserId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This mailbox has no connected owner to send as.',
          })
        }
        const msg = await loadThreadMessageContext(ctx, head.externalThreadId, {
          inboundOnly: false,
        })
        if (!msg) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'No message on this thread to forward.' })
        }

        const fwd = buildForwardQuote({
          date: msg.date,
          fromName: msg.senderName,
          fromEmail: msg.from[0] ?? null,
          to: msg.to,
          cc: msg.cc,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
        })
        const bodies = buildOutgoingEmail({
          body: input.body,
          signatureHtml: account.signatureHtml,
          signatureText: account.signatureHtml ? displayMessageBody(account.signatureHtml) : null,
          quotedText: fwd.text,
          quotedHtml: fwd.html,
        })

        // Re-attach the original attachments (streamed back from S3), bounded.
        const attachments: OutboundAttachment[] = []
        let total = 0
        for (const a of msg.attachments) {
          const obj = await getAttachment(a.s3Key)
          const buf = await streamToBuffer(obj.body)
          total += buf.byteLength
          if (total > MAX_FORWARD_ATTACH_BYTES) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Forwarded attachments exceed the 25 MB limit.',
            })
          }
          attachments.push({ filename: a.filename, contentType: a.contentType, data: buf })
        }

        const result = await sendEmail({
          agentId: account.ownerUserId,
          fromAddress: account.address ?? undefined,
          subject: forwardSubject(msg.subject),
          body: bodies.text,
          html: bodies.html,
          toAddresses: input.to,
          cc: input.cc,
          bcc: input.bcc,
          requestId: ctx.requestId,
          attachments,
        })

        // Surface the forwarded thread in /mail immediately.
        if (result.gmailThreadId) {
          await applyMailToConversation(ctx.db, {
            provider: 'email',
            externalThreadId: result.gmailThreadId,
            mailAccountId: head.mailAccountId,
            direction: 'sent',
            occurredAt: new Date(),
            contactId: null,
            familyId: null,
            subject: forwardSubject(msg.subject),
            senderName: null,
          })
        }
        await ctx.audit({
          action: 'mail.thread_forwarded',
          target: { type: 'Conversation', id: head.id },
          after: { to: input.to, cc: input.cc ?? [], attachments: attachments.length },
        })
        return { id: head.id, threadId: result.gmailThreadId }
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
