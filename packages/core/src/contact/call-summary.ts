// Call summary on a contact (independent of any Card). A staff member records
// the outcome of a call against a contact; the summary persists as a
// `call_summary` Interaction. The tRPC layer then announces it to the
// `#callsummaries` Slack channel (best-effort). No customer message is ever
// sent from the CRM (redesign 2026-07) — the summary is recorded and posted to
// Slack, nothing more.

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
