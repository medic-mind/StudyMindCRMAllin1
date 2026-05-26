// Call summary on a board card (slice B). An agent records the outcome of a
// call against a card; the summary persists as a `call_summary` Interaction on
// the card's backing Contact. The agent can then fan the summary out to Slack,
// Trengo, and email — each attempt is best-effort and independent (one failing
// channel never aborts the others), and the fan-out is recorded as a
// `call_summary_sent` Interaction with a per-channel result map plus an audit
// row.
//
// `packages/core` is pure domain logic and may not import integration clients
// (eslint no-restricted-imports). So `sendCallSummary` takes injected channel
// senders; the tRPC layer (apps/web) wires the real Slack/Trengo/Gmail
// outbound functions. This keeps the orchestration, recording, and audit here
// and testable with mocks.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma } from '@prisma/client'

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

/** A single channel's send result. `skipped` means the channel was requested
 * but not actionable (no phone, no email, no Gmail connection, etc). */
export interface ChannelResult {
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
  /** Provider reference on success (Slack ts, Trengo message id, Gmail id). */
  ref?: string
}

export type ChannelKey = 'slack' | 'trengo' | 'email'

export type SendResults = Partial<Record<ChannelKey, ChannelResult>>

/**
 * Channel senders injected by the caller. Each returns a ChannelResult and is
 * expected NOT to throw for an expected condition (token expiry, missing
 * conversation) — it returns `failed`/`skipped` instead. The orchestrator
 * still guards every call with try/catch so an unexpected throw degrades to a
 * `failed` result rather than aborting the whole fan-out.
 */
export interface CallSummarySenders {
  slack?: (args: {
    body: string
    contactName: string
    contactId: string
    slackChannelId?: string
  }) => Promise<ChannelResult>
  trengo?: (args: {
    body: string
    contactId: string
  }) => Promise<ChannelResult>
  email?: (args: {
    body: string
    contactId: string
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

async function runChannel(
  sender: (() => Promise<ChannelResult>) | undefined,
): Promise<ChannelResult> {
  if (!sender) return { status: 'skipped', detail: 'Channel sender not configured' }
  try {
    return await sender()
  } catch (err) {
    const detail =
      err instanceof BusinessError
        ? `${err.code}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err)
    return { status: 'failed', detail }
  }
}

/**
 * Fan a previously-recorded call summary out to the requested channels.
 * Best-effort per channel: each is attempted independently and a failure on
 * one never aborts the others. Records a `call_summary_sent` Interaction on
 * the backing contact carrying the per-channel result map, and audits.
 */
export async function sendCallSummary(
  db: Db,
  input: {
    summaryInteractionId: string
    channels: { slack?: boolean; trengo?: boolean; email?: boolean }
    slackChannelId?: string
    senders: CallSummarySenders
  },
  ctx: ActorCtx,
): Promise<SendResults> {
  const summary = await db.interaction.findFirst({
    where: { id: input.summaryInteractionId, type: 'call_summary', deletedAt: null },
    select: { id: true, contactId: true, payload: true },
  })
  if (!summary || !summary.contactId) {
    throw new BusinessError('CALL_SUMMARY_NOT_FOUND', 'Call summary not found')
  }
  const payload = (summary.payload as { body?: unknown } | null) ?? {}
  const body = typeof payload.body === 'string' ? payload.body : ''
  const contactId = summary.contactId

  const contact = await db.contact.findFirst({
    where: { id: contactId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true },
  })
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || 'this contact'

  const results: SendResults = {}

  if (input.channels.slack) {
    results.slack = await runChannel(
      input.senders.slack
        ? () =>
            input.senders.slack!({
              body,
              contactName,
              contactId,
              slackChannelId: input.slackChannelId,
            })
        : undefined,
    )
  }
  if (input.channels.trengo) {
    results.trengo = await runChannel(
      input.senders.trengo ? () => input.senders.trengo!({ body, contactId }) : undefined,
    )
  }
  if (input.channels.email) {
    results.email = await runChannel(
      input.senders.email ? () => input.senders.email!({ body, contactId }) : undefined,
    )
  }

  const resultsJson = toJsonResults(results)
  const id = createId()
  await db.interaction.create({
    data: {
      id,
      type: 'call_summary_sent',
      contactId,
      occurredAt: new Date(),
      summary: `Call summary sent (${describeResults(results)})`,
      payload: {
        event: 'card.call_summary_sent',
        summaryInteractionId: input.summaryInteractionId,
        channels: {
          slack: Boolean(input.channels.slack),
          trengo: Boolean(input.channels.trengo),
          email: Boolean(input.channels.email),
        },
        results: resultsJson,
      } satisfies Prisma.InputJsonObject,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.call_summary_sent',
    target: { type: 'Interaction', id: input.summaryInteractionId },
    before: null,
    after: { interactionId: id, contactId, results: resultsJson },
  })

  return results
}

/** Build a JSON-safe (no `undefined`) representation of the result map. */
function toJsonResults(results: SendResults): Prisma.InputJsonObject {
  const out: Record<string, Record<string, string>> = {}
  for (const [key, value] of Object.entries(results)) {
    if (!value) continue
    const entry: Record<string, string> = { status: value.status }
    if (value.detail !== undefined) entry.detail = value.detail
    if (value.ref !== undefined) entry.ref = value.ref
    out[key] = entry
  }
  return out
}

function describeResults(results: SendResults): string {
  const parts = Object.entries(results).map(([k, v]) => `${k}: ${v?.status}`)
  return parts.length > 0 ? parts.join(', ') : 'no channels'
}
