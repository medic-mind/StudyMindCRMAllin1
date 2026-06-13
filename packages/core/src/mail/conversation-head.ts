// Mail conversation-head upserter (ADR 0021 Phase 3b). Pure read-then-merge,
// db injected as a port so it is unit-testable and provider-agnostic (Gmail
// today; Outlook/IMAP reuse it). Mirrors the Trengo upserter
// (packages/integrations/trengo/src/conversation-head.ts) but keys on
// (provider, externalThreadId) instead of trengoTicketId.
//
// Never duplicates message bodies — those stay in `Interaction`. This row is
// the queryable *current state* of an email thread so the Comms Centre can list
// it next to Trengo conversations with one indexed query.

import { createId } from '@paralleldrive/cuid2'

import { publishConversationUpdate } from '../realtime'

/** Subset of PrismaClient used here — keeps the upserter unit-testable. */
export interface MailConversationDb {
  conversation: {
    findFirst: (args: {
      where: { provider: string; externalThreadId: string }
    }) => Promise<MailConversationRow | null>
    create: (args: { data: MailConversationCreateInput }) => Promise<MailConversationRow>
    update: (args: {
      where: { id: string }
      data: MailConversationUpdateInput
    }) => Promise<MailConversationRow>
  }
}

export interface MailConversationRow {
  id: string
  provider: string | null
  externalThreadId: string | null
  mailAccountId: string | null
  contactId: string | null
  familyId: string | null
  channel: string | null
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  lastMessageAt: Date
  lastInboundAt: Date | null
  lastOutboundAt: Date | null
  unreadCount: number
  subject: string | null
}

interface MailConversationCreateInput {
  id: string
  provider: string
  externalThreadId: string
  mailAccountId: string | null
  trengoTicketId: null
  contactId: string | null
  familyId: string | null
  channel: string
  status: 'open'
  assigneeUserId: null
  trengoAssigneeId: null
  lastMessageAt: Date
  lastInboundAt: Date | null
  lastOutboundAt: Date | null
  unreadCount: number
  subject: string | null
  tags: string[]
  replyDeadlineAt: null
}

interface MailConversationUpdateInput {
  mailAccountId?: string | null
  contactId?: string | null
  familyId?: string | null
  subject?: string | null
  lastMessageAt?: Date
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
  unreadCount?: number
}

export interface ApplyMailInput {
  /** Provider id — 'email' for Gmail today; 'outlook' / 'imap' later. */
  provider: string
  /** Gmail threadId / Outlook conversationId / IMAP thread root. */
  externalThreadId: string
  /** MailAccount.id this thread belongs to, when resolvable. */
  mailAccountId: string | null
  direction: 'received' | 'sent'
  occurredAt: Date
  contactId: string | null
  familyId: string | null
  subject: string | null
}

/**
 * Apply a single synced email message to its Conversation head. Creates the row
 * on first sight; merges thereafter. Returns the resulting row.
 *
 * Monotonic guarantees mirror the Trengo upserter:
 *  - `lastMessageAt` / `lastInboundAt` / `lastOutboundAt` only move forward.
 *  - inbound increments `unreadCount` unless it pre-dates the latest outbound
 *    (already answered); outbound resets it to 0.
 */
export async function applyMailToConversation(
  db: MailConversationDb,
  input: ApplyMailInput,
): Promise<MailConversationRow> {
  const existing = await db.conversation.findFirst({
    where: { provider: input.provider, externalThreadId: input.externalThreadId },
  })

  let row: MailConversationRow
  let changed = true
  if (!existing) {
    const isInbound = input.direction === 'received'
    row = await db.conversation.create({
      data: {
        id: createId(),
        provider: input.provider,
        externalThreadId: input.externalThreadId,
        mailAccountId: input.mailAccountId,
        trengoTicketId: null,
        contactId: input.contactId,
        familyId: input.familyId,
        channel: 'email',
        status: 'open',
        assigneeUserId: null,
        trengoAssigneeId: null,
        lastMessageAt: input.occurredAt,
        lastInboundAt: isInbound ? input.occurredAt : null,
        lastOutboundAt: isInbound ? null : input.occurredAt,
        unreadCount: isInbound ? 1 : 0,
        subject: input.subject,
        tags: [],
        replyDeadlineAt: null,
      },
    })
  } else {
    const patch = mergeMailEvent(existing, input)
    if (Object.keys(patch).length === 0) {
      row = existing
      changed = false
    } else {
      row = await db.conversation.update({ where: { id: existing.id }, data: patch })
    }
  }

  if (changed) {
    publishConversationUpdate({
      id: row.id,
      trengoTicketId: null,
      lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
      contactId: row.contactId,
    })
  }
  return row
}

function mergeMailEvent(
  existing: MailConversationRow,
  input: ApplyMailInput,
): MailConversationUpdateInput {
  const patch: MailConversationUpdateInput = {}

  // Backfill identity when we learn it and the row lacked it.
  if (input.mailAccountId && !existing.mailAccountId) patch.mailAccountId = input.mailAccountId
  if (input.contactId && !existing.contactId) patch.contactId = input.contactId
  if (input.familyId && !existing.familyId) patch.familyId = input.familyId
  if (input.subject && !existing.subject) patch.subject = input.subject

  const occurredAt = input.occurredAt
  if (occurredAt > existing.lastMessageAt) patch.lastMessageAt = occurredAt

  if (input.direction === 'received') {
    // Only a strictly-newer inbound advances the clock and bumps unread, so
    // re-applying the same message (same threadId + timestamp) is a no-op.
    const advancesInbound = !existing.lastInboundAt || occurredAt > existing.lastInboundAt
    if (advancesInbound) patch.lastInboundAt = occurredAt
    const stale = existing.lastOutboundAt && occurredAt <= existing.lastOutboundAt
    if (advancesInbound && !stale) patch.unreadCount = existing.unreadCount + 1
  } else {
    if (!existing.lastOutboundAt || occurredAt > existing.lastOutboundAt) {
      patch.lastOutboundAt = occurredAt
    }
    if (existing.unreadCount > 0) patch.unreadCount = 0
  }

  return patch
}
