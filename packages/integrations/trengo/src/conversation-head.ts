// Conversation-head upserter (ADR 0020 Phase 2). CLAUDE.md §11.
//
// The Trengo webhook job calls `applyEventToConversation` on every event so
// the `Conversation` row carries the conversation's *current* state as
// indexed columns. Pure read-then-merge — never duplicates message bodies
// (those stay in `Interaction`).
//
// Idempotency: the row is keyed on `trengoTicketId` (unique index). Replays
// either find the same row and re-apply the same transitions, or write the
// first one. State transitions are monotonic on lastMessageAt — an
// out-of-order webhook never moves the clock backwards.

import { createId } from '@paralleldrive/cuid2'

import { publishConversationUpdate } from '@studymind/core/realtime'

import { isTrengoChannel, type TrengoChannel, type TrengoEventName } from './types'

/** Subset of PrismaClient used here — keeps this file unit-testable. */
export interface ConversationHeadDb {
  conversation: {
    findUnique: (args: {
      where: { trengoTicketId: number }
      select?: Record<string, boolean>
    }) => Promise<ConversationRow | null>
    create: (args: { data: ConversationCreateInput }) => Promise<ConversationRow>
    update: (args: {
      where: { trengoTicketId: number }
      data: ConversationUpdateInput
    }) => Promise<ConversationRow>
  }
}

export interface ConversationRow {
  id: string
  /** Null for non-Trengo conversation heads (ADR 0021 Phase 3a). The Trengo
   *  upserter only operates on Trengo rows, so at runtime this is always set
   *  inside this module — the union is structural for Prisma compatibility. */
  trengoTicketId: number | null
  contactId: string | null
  familyId: string | null
  channel: string | null
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  assigneeUserId: string | null
  trengoAssigneeId: number | null
  lastMessageAt: Date
  lastInboundAt: Date | null
  lastOutboundAt: Date | null
  unreadCount: number
  subject: string | null
  tags: string[]
  replyDeadlineAt: Date | null
  lastMessagePreview?: string | null
  trengoChannelId?: number | null
  trengoChannelName?: string | null
}

interface ConversationCreateInput {
  id: string
  trengoTicketId: number
  contactId: string | null
  familyId: string | null
  channel: string | null
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  assigneeUserId: string | null
  trengoAssigneeId: number | null
  lastMessageAt: Date
  lastInboundAt: Date | null
  lastOutboundAt: Date | null
  unreadCount: number
  subject: string | null
  tags: string[]
  replyDeadlineAt: Date | null
  lastMessagePreview?: string | null
  trengoChannelId?: number | null
  trengoChannelName?: string | null
}

interface ConversationUpdateInput {
  contactId?: string | null
  familyId?: string | null
  channel?: string | null
  status?: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  assigneeUserId?: string | null
  trengoAssigneeId?: number | null
  lastMessageAt?: Date
  lastInboundAt?: Date | null
  lastOutboundAt?: Date | null
  unreadCount?: number
  subject?: string | null
  tags?: string[]
  replyDeadlineAt?: Date | null
  lastMessagePreview?: string | null
  trengoChannelId?: number | null
  trengoChannelName?: string | null
}

export interface ApplyEventInput {
  ticketId: number
  eventName: TrengoEventName
  occurredAt: Date
  channel?: string | null
  contactId?: string | null
  familyId?: string | null
  /** Raw Trengo assignee id (numeric). The CRM-User mapping happens upstream. */
  trengoAssigneeId?: number | null
  /** CRM User id when we have a mapping (User.trengoUserId, future). */
  assigneeUserId?: string | null
  /** Email subject for email-channel conversations; ignored otherwise. */
  subject?: string | null
  /** Label name on label.added / label.removed. */
  label?: string | null
  /** Message body (message events) — feeds the list-row preview. */
  preview?: string | null
  /** The SPECIFIC Trengo channel ("business number" / inbox) id + name, when
   *  the event/ticket carried it. Backfilled onto the head; name denormalised
   *  for display. */
  trengoChannelId?: number | null
  trengoChannelName?: string | null
}

export const WHATSAPP_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Apply a single Trengo webhook event to the Conversation head. Creates the
 * row on first sight; merges state thereafter. Returns the resulting row.
 *
 * Monotonic guarantees:
 *  - `lastMessageAt` only moves forward.
 *  - `lastInboundAt` only moves forward.
 *  - `unreadCount` increments on inbound; resets to 0 on outbound. An
 *     out-of-order inbound that pre-dates the latest outbound does NOT bump
 *     the unread count (the agent has already responded).
 */
export async function applyEventToConversation(
  db: ConversationHeadDb,
  input: ApplyEventInput,
): Promise<ConversationRow> {
  const existing = await db.conversation.findUnique({
    where: { trengoTicketId: input.ticketId },
  })
  let row: ConversationRow
  let changed = true
  if (!existing) {
    row = await db.conversation.create({ data: buildCreateForEvent(input) })
  } else {
    const patch = mergeEvent(existing, input)
    if (Object.keys(patch).length === 0) {
      row = existing
      changed = false
    } else {
      row = await db.conversation.update({
        where: { trengoTicketId: input.ticketId },
        data: patch,
      })
    }
  }
  // ADR 0020 Phase 3 — fan out to in-process SSE subscribers when anything
  // about the head changed. Skip no-op merges so we do not nudge the UI for
  // a duplicate webhook that already converged.
  if (changed) {
    publishConversationUpdate({
      id: row.id,
      trengoTicketId: row.trengoTicketId,
      lastMessageAt: row.lastMessageAt
        ? row.lastMessageAt.toISOString()
        : null,
      contactId: row.contactId,
    })
  }
  return row
}

function buildCreateForEvent(input: ApplyEventInput): ConversationCreateInput {
  const channel =
    input.channel && isTrengoChannel(input.channel) ? input.channel : null
  const isInbound = input.eventName === 'message.inbound'
  const isOutbound = input.eventName === 'message.outbound'
  const isClose = input.eventName === 'ticket.closed'
  const isReopen = input.eventName === 'ticket.reopened'

  return {
    id: createId(),
    trengoTicketId: input.ticketId,
    contactId: input.contactId ?? null,
    familyId: input.familyId ?? null,
    channel,
    status: isClose ? 'closed' : isReopen ? 'open' : 'open',
    assigneeUserId: input.assigneeUserId ?? null,
    trengoAssigneeId: input.trengoAssigneeId ?? null,
    lastMessageAt: input.occurredAt,
    lastInboundAt: isInbound ? input.occurredAt : null,
    lastOutboundAt: isOutbound ? input.occurredAt : null,
    unreadCount: isInbound ? 1 : 0,
    subject: input.subject ?? null,
    lastMessagePreview:
      (isInbound || isOutbound) && input.preview ? input.preview.slice(0, 140) : null,
    tags: input.eventName === 'label.added' && input.label ? [input.label] : [],
    replyDeadlineAt:
      isInbound && channel === 'whatsapp'
        ? new Date(input.occurredAt.getTime() + WHATSAPP_REPLY_WINDOW_MS)
        : null,
    trengoChannelId: input.trengoChannelId ?? null,
    trengoChannelName: input.trengoChannelName ?? null,
  }
}

function mergeEvent(
  existing: ConversationRow,
  input: ApplyEventInput,
): ConversationUpdateInput {
  const patch: ConversationUpdateInput = {}

  // Always backfill identity fields when we have them and the row didn't.
  if (input.contactId && !existing.contactId) patch.contactId = input.contactId
  if (input.familyId && !existing.familyId) patch.familyId = input.familyId
  // The specific channel ("business number") — set when we learn it or it
  // changed (a conversation rarely moves channel, but the name can be filled
  // in later once the channel mirror is synced).
  if (
    input.trengoChannelId != null &&
    existing.trengoChannelId !== input.trengoChannelId
  ) {
    patch.trengoChannelId = input.trengoChannelId
  }
  if (
    input.trengoChannelName &&
    existing.trengoChannelName !== input.trengoChannelName
  ) {
    patch.trengoChannelName = input.trengoChannelName
  }
  if (
    input.channel &&
    isTrengoChannel(input.channel) &&
    existing.channel !== input.channel
  ) {
    patch.channel = input.channel
  }
  if (input.subject && !existing.subject) patch.subject = input.subject

  const occurredAt = input.occurredAt
  const advancesLastMessage = occurredAt > existing.lastMessageAt
  if (advancesLastMessage) patch.lastMessageAt = occurredAt
  if (
    advancesLastMessage &&
    input.preview &&
    (input.eventName === 'message.inbound' || input.eventName === 'message.outbound')
  ) {
    patch.lastMessagePreview = input.preview.slice(0, 140)
  }

  switch (input.eventName) {
    case 'message.inbound': {
      if (!existing.lastInboundAt || occurredAt > existing.lastInboundAt) {
        patch.lastInboundAt = occurredAt
      }
      // Don't bump unread for a stale inbound that already pre-dates an
      // outbound (the agent has answered).
      const stale =
        existing.lastOutboundAt && occurredAt <= existing.lastOutboundAt
      if (!stale) patch.unreadCount = existing.unreadCount + 1
      const channel: TrengoChannel | null =
        existing.channel && isTrengoChannel(existing.channel)
          ? (existing.channel as TrengoChannel)
          : input.channel && isTrengoChannel(input.channel)
            ? input.channel
            : null
      if (channel === 'whatsapp') {
        const deadline = new Date(occurredAt.getTime() + WHATSAPP_REPLY_WINDOW_MS)
        if (!existing.replyDeadlineAt || deadline > existing.replyDeadlineAt) {
          patch.replyDeadlineAt = deadline
        }
      }
      break
    }
    case 'message.outbound': {
      if (!existing.lastOutboundAt || occurredAt > existing.lastOutboundAt) {
        patch.lastOutboundAt = occurredAt
      }
      if (existing.unreadCount > 0) patch.unreadCount = 0
      break
    }
    case 'ticket.closed':
      if (existing.status !== 'closed') patch.status = 'closed'
      break
    case 'ticket.reopened':
      if (existing.status !== 'open') patch.status = 'open'
      break
    case 'ticket.assigned': {
      if (
        input.trengoAssigneeId !== undefined &&
        input.trengoAssigneeId !== null &&
        existing.trengoAssigneeId !== input.trengoAssigneeId
      ) {
        patch.trengoAssigneeId = input.trengoAssigneeId
      }
      if (input.assigneeUserId && existing.assigneeUserId !== input.assigneeUserId) {
        patch.assigneeUserId = input.assigneeUserId
      }
      break
    }
    case 'label.added': {
      if (input.label && !existing.tags.includes(input.label)) {
        patch.tags = [...existing.tags, input.label]
      }
      break
    }
    case 'label.removed': {
      if (input.label && existing.tags.includes(input.label)) {
        patch.tags = existing.tags.filter((t) => t !== input.label)
      }
      break
    }
  }

  return patch
}
