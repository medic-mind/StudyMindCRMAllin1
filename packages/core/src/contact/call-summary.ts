// Call summary on a contact (independent of any Card). An agent records the
// outcome of a call against a contact; the summary persists as a
// `call_summary` Interaction. The agent can then fan it out to Slack /
// Trengo / email, each channel best-effort and independent (one failure
// never aborts the others). Mirrors the existing board.callSummary flow.
//
// `packages/core` cannot import integration clients, so the senders are
// injected by the tRPC layer.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type Db = PrismaClient | Prisma.TransactionClient
export interface ActorCtx {
  actorId: string | null
  requestId?: string | undefined
}

export type CallOutcome = 'answered' | 'voicemail' | 'no_answer'

export interface ChannelResult {
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
  ref?: string
}

export type ChannelKey = 'slack' | 'trengo' | 'email'
export type SendResults = Partial<Record<ChannelKey, ChannelResult>>

export interface CallSummarySenders {
  slack?: (args: {
    body: string
    contactName: string
    contactId: string
    slackChannelId?: string
  }) => Promise<ChannelResult>
  trengo?: (args: { body: string; contactId: string }) => Promise<ChannelResult>
  email?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<{
      filename: string
      contentType: string
      data: Buffer
    }>
  }) => Promise<ChannelResult>
}

export interface CallSummaryInteraction {
  id: string
  contactId: string
  body: string
  outcome: CallOutcome | null
  occurredAt: Date
}

export async function addContactCallSummary(
  db: Db,
  input: { contactId: string; body: string; outcome?: CallOutcome | null },
  ctx: ActorCtx,
): Promise<CallSummaryInteraction> {
  const body = input.body.trim()
  if (body.length === 0) {
    throw new BusinessError('CALL_SUMMARY_EMPTY', 'A call summary cannot be empty')
  }
  const contact = await db.contact.findFirst({
    where: { id: input.contactId, deletedAt: null },
    select: { id: true },
  })
  if (!contact) throw new BusinessError('CONTACT_NOT_FOUND', 'Contact not found')

  const id = createId()
  const occurredAt = new Date()
  await db.interaction.create({
    data: {
      id,
      type: 'call_summary',
      contactId: contact.id,
      occurredAt,
      summary: body.length > 120 ? `${body.slice(0, 117)}…` : body,
      payload: {
        event: 'contact.call_summary_added',
        body,
        outcome: input.outcome ?? null,
        authorId: ctx.actorId,
      } satisfies Prisma.InputJsonObject,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'contact.call_summary_added',
    target: { type: 'Contact', id: contact.id },
    before: null,
    after: { interactionId: id, outcome: input.outcome ?? null },
  })

  return {
    id,
    contactId: contact.id,
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

function describeResults(r: SendResults): string {
  const parts: string[] = []
  for (const k of ['slack', 'trengo', 'email'] as ChannelKey[]) {
    const v = r[k]
    if (!v) continue
    parts.push(`${k}: ${v.status}`)
  }
  return parts.join(', ') || 'no channels'
}

function toJsonResults(r: SendResults): Prisma.InputJsonObject {
  const out: Record<string, unknown> = {}
  for (const k of ['slack', 'trengo', 'email'] as ChannelKey[]) {
    const v = r[k]
    if (!v) continue
    out[k] = {
      status: v.status,
      ...(v.detail !== undefined ? { detail: v.detail } : {}),
      ...(v.ref !== undefined ? { ref: v.ref } : {}),
    }
  }
  return out as Prisma.InputJsonObject
}

export async function sendContactCallSummary(
  db: Db,
  input: {
    summaryInteractionId: string
    channels: { slack?: boolean; trengo?: boolean; email?: boolean }
    slackChannelId?: string
    /** Optional pre-resolved attachments for the email channel. */
    emailAttachments?: ReadonlyArray<{
      filename: string
      contentType: string
      data: Buffer
    }>
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
      input.senders.email
        ? () =>
            input.senders.email!({
              body,
              contactId,
              attachments: input.emailAttachments,
            })
        : undefined,
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
        event: 'contact.call_summary_sent',
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
    action: 'contact.call_summary_sent',
    target: { type: 'Interaction', id: input.summaryInteractionId },
    before: null,
    after: { interactionId: id, contactId, results: resultsJson },
  })

  return results
}
