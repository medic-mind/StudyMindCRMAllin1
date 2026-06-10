// Per-channel view-models for the comprehensive customer view (ADR 0017).
//
// Each function takes a Prisma client + the contactId + an optional cursor
// and returns paginated, channel-specific shapes (NOT raw Interaction rows).
// The caller is responsible for permission checks; these constructors are
// pure data shapers.
//
// Cursor shape is `{ id, occurredAt }` per CLAUDE.md §27 (limit max 100).

import type { PrismaClient } from '@prisma/client'

// -----------------------------------------------------------------------------
// Common
// -----------------------------------------------------------------------------

export interface ChannelCursor {
  id: string
  occurredAt: Date
}

export interface ChannelListInput {
  contactId: string
  limit?: number
  cursor?: ChannelCursor | null
}

export interface Paginated<T> {
  items: T[]
  nextCursor: ChannelCursor | null
}

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT
  return Math.min(limit, MAX_LIMIT)
}

function cursorWhere(cursor: ChannelCursor | null | undefined): object {
  if (!cursor) return {}
  return {
    OR: [
      { occurredAt: { lt: cursor.occurredAt } },
      {
        AND: [{ occurredAt: cursor.occurredAt }, { id: { lt: cursor.id } }],
      },
    ],
  }
}

function nextCursor<T extends { id: string; occurredAt: Date }>(
  rows: T[],
  limit: number,
): { sliced: T[]; nextCursor: ChannelCursor | null } {
  const hasMore = rows.length > limit
  const sliced = hasMore ? rows.slice(0, limit) : rows
  const last = sliced[sliced.length - 1]
  return {
    sliced,
    nextCursor: hasMore && last ? { id: last.id, occurredAt: last.occurredAt } : null,
  }
}

function asObject(p: unknown): Record<string, unknown> {
  if (p && typeof p === 'object' && !Array.isArray(p)) {
    return p as Record<string, unknown>
  }
  return {}
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' ? v : null
}

// -----------------------------------------------------------------------------
// Email — threaded view
// -----------------------------------------------------------------------------

export interface EmailMessage {
  id: string
  occurredAt: Date
  direction: 'sent' | 'received'
  from: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string | null
  snippet: string | null
  attachments: Array<{ s3Key: string; filename: string; mimeType: string; sizeBytes: number }>
  unread: boolean
  gmailMessageId: string | null
}

export interface EmailThread {
  threadId: string
  subject: string | null
  participantEmails: string[]
  messageCount: number
  unreadCount: number
  latestSnippet: string | null
  latestAt: Date
  messages: EmailMessage[]
}

function rowToEmailMessage(row: {
  id: string
  occurredAt: Date
  summary: string | null
  payload: unknown
  type: string
}): EmailMessage {
  const p = asObject(row.payload)
  const labels = asStringArray(p['labels'])
  const atts = Array.isArray(p['attachments']) ? p['attachments'] : []
  const attachments = atts
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
    .map((a) => ({
      s3Key: asString(a['s3Key']) ?? '',
      filename: asString(a['filename']) ?? '',
      mimeType: asString(a['mimeType']) ?? 'application/octet-stream',
      sizeBytes: asNumber(a['sizeBytes']) ?? 0,
    }))
  return {
    id: row.id,
    occurredAt: row.occurredAt,
    direction: row.type === 'email_sent' ? 'sent' : 'received',
    from: asStringArray(p['from']),
    to: asStringArray(p['to']),
    cc: asStringArray(p['cc']),
    bcc: asStringArray(p['bcc']),
    subject: asString(p['subject']) ?? row.summary,
    snippet: row.summary ?? asString(p['snippet']),
    attachments,
    unread: labels.includes('UNREAD'),
    gmailMessageId: asString(p['gmailMessageId']),
  }
}

export async function emailThreadsForContact(
  db: PrismaClient,
  input: ChannelListInput,
): Promise<Paginated<EmailThread>> {
  const limit = clampLimit(input.limit)
  // Pull a wider page of raw messages so we can group into threads, then
  // emit threads in order of their newest message. We over-fetch by ~3x to
  // keep tail-of-page grouping accurate without pulling unbounded data.
  const sweep = Math.min(limit * 4 + 1, 400)
  const rows = await db.interaction.findMany({
    where: {
      contactId: input.contactId,
      deletedAt: null,
      type: { in: ['email_received', 'email_sent'] },
      ...cursorWhere(input.cursor),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: sweep,
    select: {
      id: true,
      occurredAt: true,
      summary: true,
      payload: true,
      type: true,
    },
  })

  const threads = new Map<string, EmailThread>()
  const order: string[] = []
  for (const r of rows) {
    const p = asObject(r.payload)
    const threadId = asString(p['gmailThreadId']) ?? `single:${r.id}`
    const msg = rowToEmailMessage(r)
    let t = threads.get(threadId)
    if (!t) {
      t = {
        threadId,
        subject: msg.subject,
        participantEmails: [],
        messageCount: 0,
        unreadCount: 0,
        latestSnippet: msg.snippet,
        latestAt: msg.occurredAt,
        messages: [],
      }
      threads.set(threadId, t)
      order.push(threadId)
    }
    t.messages.push(msg)
    t.messageCount += 1
    if (msg.unread) t.unreadCount += 1
    if (msg.occurredAt > t.latestAt) {
      t.latestAt = msg.occurredAt
      t.latestSnippet = msg.snippet
      t.subject = msg.subject ?? t.subject
    }
    for (const e of [...msg.from, ...msg.to, ...msg.cc]) {
      if (!t.participantEmails.includes(e)) t.participantEmails.push(e)
    }
  }

  // Order threads by their newest message.
  const ordered = order
    .map((k) => threads.get(k))
    .filter((t): t is EmailThread => !!t)
    .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())

  // Sort messages within each thread chronologically (oldest → newest).
  for (const t of ordered) {
    t.messages.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
  }

  const hasMore = ordered.length > limit
  const sliced = hasMore ? ordered.slice(0, limit) : ordered
  const last = sliced[sliced.length - 1]
  const last_message = last?.messages[last.messages.length - 1]
  return {
    items: sliced,
    nextCursor:
      hasMore && last_message
        ? { id: last_message.id, occurredAt: last_message.occurredAt }
        : null,
  }
}

// -----------------------------------------------------------------------------
// Calls
// -----------------------------------------------------------------------------

export interface CallAiOutcome {
  outcome: string
  sentiment: string | null
  suggestedFollowUp: string | null
  confidence: number | null
}

export interface CallEntry {
  id: string
  occurredAt: Date
  direction: 'inbound' | 'outbound' | null
  outcome: 'answered' | 'voicemail' | 'missed' | 'unknown'
  durationSec: number | null
  recordingS3Key: string | null
  recordingUrl: string | null
  voicemailUrl: string | null
  /** True when there is any audio to stream (S3 copy or a live provider URL). */
  hasRecording: boolean
  transcript: string | null
  /** AI outcome classification (Whisper fallback path), when present. */
  aiOutcome: CallAiOutcome | null
  aircallCallId: number | null
  interactionType: string | null
  triageRequired: boolean
}

function parseAiOutcome(value: unknown): CallAiOutcome | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const outcome = asString(o['outcome'])
  if (!outcome) return null
  return {
    outcome,
    sentiment: asString(o['sentiment']),
    suggestedFollowUp: asString(o['suggestedFollowUp']),
    confidence: asNumber(o['confidence']),
  }
}

function classifyOutcome(p: Record<string, unknown>): CallEntry['outcome'] {
  const it = asString(p['interactionType']) ?? asString(p['aircallEvent'])
  if (!it) return 'unknown'
  if (it.includes('voicemail')) return 'voicemail'
  if (it.includes('answered')) return 'answered'
  if (it.includes('ended') || it.includes('hungup')) {
    // call.ended without an answered preceding usually means missed; we
    // surface that distinctly so the UI can badge it.
    const dur = asNumber(p['durationSec'])
    if (dur !== null && dur > 0) return 'answered'
    return 'missed'
  }
  return 'unknown'
}

export async function callsForContact(
  db: PrismaClient,
  input: ChannelListInput,
): Promise<Paginated<CallEntry>> {
  const limit = clampLimit(input.limit)
  const rows = await db.interaction.findMany({
    where: {
      contactId: input.contactId,
      deletedAt: null,
      type: 'call',
      ...cursorWhere(input.cursor),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, occurredAt: true, payload: true },
  })
  const { sliced, nextCursor: nc } = nextCursor(rows, limit)
  const items: CallEntry[] = sliced.map((r) => {
    const p = asObject(r.payload)
    const dir = asString(p['direction'])
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      direction:
        dir === 'inbound' || dir === 'outbound' ? dir : null,
      outcome: classifyOutcome(p),
      durationSec: asNumber(p['durationSec']),
      recordingS3Key: asString(p['recordingS3Key']),
      recordingUrl: asString(p['recordingUrl']),
      voicemailUrl: asString(p['voicemailUrl']),
      hasRecording: Boolean(
        asString(p['recordingS3Key']) ||
          asString(p['recordingUrl']) ||
          asString(p['voicemailUrl']),
      ),
      transcript: asString(p['transcriptText']),
      aiOutcome: parseAiOutcome(p['aiOutcome']),
      aircallCallId: asNumber(p['aircallCallId']),
      interactionType: asString(p['interactionType']),
      triageRequired: p['triageRequired'] === true,
    }
  })
  return { items, nextCursor: nc }
}

// -----------------------------------------------------------------------------
// Slack mentions
// -----------------------------------------------------------------------------

export interface SlackMention {
  id: string
  occurredAt: Date
  channelId: string | null
  channelName: string | null
  senderName: string | null
  messageText: string | null
  summary: string | null
  category: string | null
  sentiment: string | null
  suggestedNextAction: string | null
  permalink: string | null
  confidence: number | null
}

export async function slackMentionsForContact(
  db: PrismaClient,
  input: ChannelListInput,
): Promise<Paginated<SlackMention>> {
  const limit = clampLimit(input.limit)
  const rows = await db.interaction.findMany({
    where: {
      contactId: input.contactId,
      deletedAt: null,
      type: 'slack_summary',
      ...cursorWhere(input.cursor),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: { id: true, occurredAt: true, summary: true, payload: true },
  })
  const { sliced, nextCursor: nc } = nextCursor(rows, limit)
  const items: SlackMention[] = sliced.map((r) => {
    const p = asObject(r.payload)
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      channelId: asString(p['channelId']),
      channelName: asString(p['channelName']),
      senderName: asString(p['senderName']),
      messageText: asString(p['messageText']),
      summary: r.summary,
      category: asString(p['category']),
      sentiment: asString(p['sentiment']),
      suggestedNextAction: asString(p['suggestedNextAction']),
      permalink: asString(p['permalink']) ?? asString(p['slackPermalink']),
      confidence: asNumber(p['confidence']),
    }
  })
  return { items, nextCursor: nc }
}

// -----------------------------------------------------------------------------
// Trengo conversations — grouped by ticketId
// -----------------------------------------------------------------------------

export type TrengoChannel = 'whatsapp' | 'sms' | 'email' | 'web_chat' | null

const TRENGO_LIFECYCLE_TYPES = [
  'message',
  'ticket_assigned',
  'ticket_closed',
  'ticket_reopened',
  'label_added',
  'label_removed',
] as const

export interface TrengoConversation {
  conversationId: string
  channel: TrengoChannel
  ticketStatus: string | null
  messageCount: number
  latestSnippet: string | null
  latestAt: Date
  /** Outbound deadline derived from WhatsApp 24h window — null otherwise. */
  replyDeadlineAt: Date | null
}

export async function trengoConversationsForContact(
  db: PrismaClient,
  input: ChannelListInput,
): Promise<Paginated<TrengoConversation>> {
  const limit = clampLimit(input.limit)
  const sweep = Math.min(limit * 4 + 1, 400)
  const rows = await db.interaction.findMany({
    where: {
      contactId: input.contactId,
      deletedAt: null,
      type: { in: [...TRENGO_LIFECYCLE_TYPES] },
      ...cursorWhere(input.cursor),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: sweep,
    select: { id: true, occurredAt: true, summary: true, payload: true, type: true },
  })

  const convs = new Map<string, TrengoConversation>()
  const order: string[] = []
  for (const r of rows) {
    const p = asObject(r.payload)
    const ticketId =
      asString(p['ticketId']) ??
      (typeof p['ticketId'] === 'number' ? String(p['ticketId']) : null) ??
      `single:${r.id}`
    let c = convs.get(ticketId)
    if (!c) {
      const ch = asString(p['channel']) as TrengoChannel
      c = {
        conversationId: ticketId,
        channel: ch,
        ticketStatus: null,
        messageCount: 0,
        latestSnippet: r.summary,
        latestAt: r.occurredAt,
        replyDeadlineAt: null,
      }
      convs.set(ticketId, c)
      order.push(ticketId)
    }
    if (r.type === 'message') c.messageCount += 1
    if (r.type === 'ticket_closed') c.ticketStatus = 'closed'
    if (r.type === 'ticket_reopened') c.ticketStatus = 'open'
    if (r.type === 'ticket_assigned' && !c.ticketStatus) c.ticketStatus = 'assigned'
    if (r.occurredAt > c.latestAt) {
      c.latestAt = r.occurredAt
      c.latestSnippet = r.summary ?? c.latestSnippet
    }
    // WhatsApp 24-hour reply window. Inbound messages reset the clock; we
    // surface the most recent inbound time + 24h as the deadline.
    if (
      c.channel === 'whatsapp' &&
      r.type === 'message' &&
      asString(p['interactionType']) === 'message.inbound'
    ) {
      const deadline = new Date(r.occurredAt.getTime() + 24 * 60 * 60 * 1000)
      if (!c.replyDeadlineAt || deadline > c.replyDeadlineAt) {
        c.replyDeadlineAt = deadline
      }
    }
  }

  const ordered = order
    .map((k) => convs.get(k))
    .filter((c): c is TrengoConversation => !!c)
    .sort((a, b) => b.latestAt.getTime() - a.latestAt.getTime())

  const hasMore = ordered.length > limit
  const sliced = hasMore ? ordered.slice(0, limit) : ordered
  // Cursor for conversation pagination uses the latest message we walked.
  const lastRow = rows[rows.length - 1]
  return {
    items: sliced,
    nextCursor:
      hasMore && lastRow ? { id: lastRow.id, occurredAt: lastRow.occurredAt } : null,
  }
}

// -----------------------------------------------------------------------------
// Trengo tags — aggregated across the contact's conversations (ADR 0020 Phase
// 6b). Reads the `Conversation` head where `tags` is an indexed column;
// returns the unique set ordered by frequency, with the per-tag conversation
// count so the UI can dim infrequent tags. Pure read — no contact mutation.
// -----------------------------------------------------------------------------

export interface ContactTrengoTag {
  /** Tag name as Trengo sent it (label.name). */
  name: string
  /** How many of the contact's Conversation heads carry this tag. */
  conversationCount: number
}

export async function trengoTagsForContact(
  db: PrismaClient,
  contactId: string,
): Promise<ContactTrengoTag[]> {
  const rows = await db.conversation.findMany({
    where: { contactId },
    select: { tags: true },
  })
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const t of r.tags) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }
  return Array.from(counts.entries())
    .map(([name, conversationCount]) => ({ name, conversationCount }))
    .sort((a, b) =>
      b.conversationCount - a.conversationCount || a.name.localeCompare(b.name),
    )
}

// -----------------------------------------------------------------------------
// Tasks
// -----------------------------------------------------------------------------

export interface TaskEntry {
  id: string
  title: string
  status: string
  dueAt: Date | null
  assigneeId: string | null
  description: string | null
}

export async function tasksForContact(
  db: PrismaClient,
  input: { contactId: string },
): Promise<{ open: TaskEntry[]; closed: TaskEntry[] }> {
  const rows = await db.task.findMany({
    where: { contactId: input.contactId, deletedAt: null },
    orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { id: 'desc' }],
    take: 200,
    select: {
      id: true,
      title: true,
      status: true,
      dueAt: true,
      assigneeId: true,
      description: true,
    },
  })
  const open: TaskEntry[] = []
  const closed: TaskEntry[] = []
  for (const r of rows) {
    if (r.status === 'done' || r.status === 'cancelled') closed.push(r)
    else open.push(r)
  }
  return { open, closed }
}

// -----------------------------------------------------------------------------
// Notes
// -----------------------------------------------------------------------------

export interface NoteEntry {
  id: string
  occurredAt: Date
  body: string | null
  summary: string | null
  authorId: string | null
}

export async function notesForContact(
  db: PrismaClient,
  input: ChannelListInput,
): Promise<Paginated<NoteEntry>> {
  const limit = clampLimit(input.limit)
  const rows = await db.interaction.findMany({
    where: {
      contactId: input.contactId,
      deletedAt: null,
      type: 'note',
      ...cursorWhere(input.cursor),
    },
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    select: {
      id: true,
      occurredAt: true,
      summary: true,
      payload: true,
      createdById: true,
    },
  })
  const { sliced, nextCursor: nc } = nextCursor(rows, limit)
  const items: NoteEntry[] = sliced.map((r) => {
    const p = asObject(r.payload)
    return {
      id: r.id,
      occurredAt: r.occurredAt,
      summary: r.summary,
      body: asString(p['body']) ?? r.summary,
      authorId: r.createdById,
    }
  })
  return { items, nextCursor: nc }
}

// -----------------------------------------------------------------------------
// Per-contact channel summary — used by the KPI tiles at the top of the page.
// One round-trip, returns counts per channel + latest entry per channel.
// -----------------------------------------------------------------------------

export interface ChannelSummary {
  emails: { threadCount: number; unreadCount: number; latestAt: Date | null }
  calls: { recentCount: number; missedCount: number; latestAt: Date | null }
  slack: { mentionCount: number; latestAt: Date | null }
  trengo: { conversationCount: number; latestAt: Date | null }
  tasks: { openCount: number }
  notes: { count: number; latestAt: Date | null }
}

export async function channelSummaryForContact(
  db: PrismaClient,
  contactId: string,
): Promise<ChannelSummary> {
  // We deliberately do a small set of cheap aggregates rather than one big
  // group-by, so each can use the partial index added in the chunk-1 migration.
  const [emails, calls, slack, trengoMsgs, tasksOpen, notes] = await Promise.all([
    db.interaction.findMany({
      where: {
        contactId,
        deletedAt: null,
        type: { in: ['email_received', 'email_sent'] },
      },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: { occurredAt: true, payload: true },
    }),
    db.interaction.findMany({
      where: { contactId, deletedAt: null, type: 'call' },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: { occurredAt: true, payload: true },
    }),
    db.interaction.aggregate({
      where: { contactId, deletedAt: null, type: 'slack_summary' },
      _count: { id: true },
      _max: { occurredAt: true },
    }),
    db.interaction.findMany({
      where: { contactId, deletedAt: null, type: 'message' },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: { occurredAt: true, payload: true },
    }),
    db.task.count({
      where: {
        contactId,
        deletedAt: null,
        status: { notIn: ['done', 'cancelled'] },
      },
    }),
    db.interaction.aggregate({
      where: { contactId, deletedAt: null, type: 'note' },
      _count: { id: true },
      _max: { occurredAt: true },
    }),
  ])

  const threadIds = new Set<string>()
  let unread = 0
  let emailLatest: Date | null = null
  for (const r of emails) {
    const p = asObject(r.payload)
    const tid = asString(p['gmailThreadId']) ?? `single:${r.occurredAt.toISOString()}`
    threadIds.add(tid)
    if (asStringArray(p['labels']).includes('UNREAD')) unread += 1
    if (!emailLatest || r.occurredAt > emailLatest) emailLatest = r.occurredAt
  }

  let missed = 0
  let callLatest: Date | null = null
  for (const r of calls) {
    const p = asObject(r.payload)
    if (classifyOutcome(p) === 'missed') missed += 1
    if (!callLatest || r.occurredAt > callLatest) callLatest = r.occurredAt
  }

  const trengoConvs = new Set<string>()
  let trengoLatest: Date | null = null
  for (const r of trengoMsgs) {
    const p = asObject(r.payload)
    const tid =
      asString(p['ticketId']) ??
      (typeof p['ticketId'] === 'number' ? String(p['ticketId']) : null)
    if (tid) trengoConvs.add(tid)
    if (!trengoLatest || r.occurredAt > trengoLatest) trengoLatest = r.occurredAt
  }

  return {
    emails: {
      threadCount: threadIds.size,
      unreadCount: unread,
      latestAt: emailLatest,
    },
    calls: {
      recentCount: calls.length,
      missedCount: missed,
      latestAt: callLatest,
    },
    slack: {
      mentionCount: slack._count.id,
      latestAt: slack._max.occurredAt,
    },
    trengo: {
      conversationCount: trengoConvs.size,
      latestAt: trengoLatest,
    },
    tasks: { openCount: tasksOpen },
    notes: { count: notes._count.id, latestAt: notes._max.occurredAt },
  }
}

// -----------------------------------------------------------------------------
// Cross-channel search — fuzzy substring across summary/payload text fields.
// -----------------------------------------------------------------------------

export interface ChannelSearchHit {
  id: string
  channel: 'email' | 'call' | 'slack' | 'trengo' | 'note'
  occurredAt: Date
  snippet: string
}

export async function searchAcrossChannels(
  db: PrismaClient,
  contactId: string,
  q: string,
): Promise<ChannelSearchHit[]> {
  const trimmed = q.trim()
  if (trimmed.length < 2) return []
  // Postgres `contains` on a JSONB column requires a path; cheapest portable
  // approach is to search the summary column (indexed by the partial index
  // we added) and post-filter the payload in JS for the top hits.
  const rows = await db.interaction.findMany({
    where: {
      contactId,
      deletedAt: null,
      OR: [
        { summary: { contains: trimmed, mode: 'insensitive' } },
      ],
    },
    orderBy: { occurredAt: 'desc' },
    take: 60,
    select: { id: true, occurredAt: true, summary: true, type: true, payload: true },
  })

  const channelOf = (t: string): ChannelSearchHit['channel'] | null => {
    if (t === 'email_received' || t === 'email_sent') return 'email'
    if (t === 'call') return 'call'
    if (t === 'slack_summary') return 'slack'
    if (t === 'message') return 'trengo'
    if (t === 'note') return 'note'
    return null
  }

  const hits: ChannelSearchHit[] = []
  for (const r of rows) {
    const ch = channelOf(r.type)
    if (!ch) continue
    const p = asObject(r.payload)
    const body =
      asString(p['body']) ??
      asString(p['messageText']) ??
      asString(p['transcriptText']) ??
      asString(p['subject']) ??
      ''
    const snippetSource = r.summary ?? body
    const snippet = snippetSource.slice(0, 200)
    hits.push({ id: r.id, channel: ch, occurredAt: r.occurredAt, snippet })
    if (hits.length >= 20) break
  }
  return hits
}
