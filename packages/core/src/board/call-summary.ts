// Call summary on a board card. An agent records the outcome of a call against
// a card; the summary persists as a `call_summary` Interaction on the card's
// backing Contact. The tRPC layer then announces it to the `#callsummaries`
// Slack channel (best-effort) — no customer message is ever sent from the CRM
// (redesign 2026-07). `packages/core` is pure domain logic and may not import
// integration clients, so the Slack sender is injected by the tRPC layer.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

export type CallOutcome = 'answered' | 'voicemail' | 'no_answer'

export interface CallSummaryInteraction {
  id: string
  contactId: string
  cardId: string
  body: string
  outcome: CallOutcome | null
  occurredAt: Date
}

/** The Slack post result (best-effort — a failure never loses the CRM record). */
export interface ChannelResult {
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
  /** Provider reference on success (Slack ts). */
  ref?: string
}

/**
 * The Slack sender injected by the caller. Returns a ChannelResult and is
 * expected NOT to throw for an expected condition (no channel configured) — it
 * returns `skipped`/`failed` instead.
 */
export interface CallSummarySenders {
  slack?: (args: {
    body: string
    contactName: string
    contactId: string
    slackChannelId?: string
    outcome?: CallOutcome | null
    /** Staff member who logged the summary (rendered as a footer). */
    authorName?: string | null
  }) => Promise<ChannelResult>
}

/**
 * Record a call summary against a card. Resolves the card's backing contact,
 * writes a `call_summary` Interaction linked to that contact, and audits.
 */
export async function addCallSummary(
  db: Db,
  input: { cardId: string; authorId: string; body: string; outcome?: CallOutcome },
  ctx: ActorCtx,
): Promise<CallSummaryInteraction> {
  const body = input.body.trim()
  if (body.length === 0) {
    throw new BusinessError('CALL_SUMMARY_EMPTY', 'A call summary cannot be empty')
  }

  const card = await db.card.findFirst({
    where: { id: input.cardId, archivedAt: null },
    select: { id: true, contactId: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  const id = createId()
  const occurredAt = new Date()
  await db.interaction.create({
    data: {
      id,
      type: 'call_summary',
      contactId: card.contactId,
      occurredAt,
      summary: body.length > 120 ? `${body.slice(0, 117)}…` : body,
      payload: {
        event: 'card.call_summary_added',
        cardId: input.cardId,
        body,
        outcome: input.outcome ?? null,
        authorId: input.authorId,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.call_summary_added',
    target: { type: 'Card', id: input.cardId },
    before: null,
    after: { interactionId: id, contactId: card.contactId, outcome: input.outcome ?? null },
  })

  return {
    id,
    contactId: card.contactId,
    cardId: input.cardId,
    body,
    outcome: input.outcome ?? null,
    occurredAt,
  }
}
