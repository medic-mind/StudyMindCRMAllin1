// Trengo Inngest functions. CLAUDE.md §7.1, §11, §17.
//
// Inbound events match by phone (E.164) first, then email. If neither
// matches we create a Lead (NEVER a Contact — that path has been bitten by
// spam routes creating ghost Contacts in the past).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import {
  isTrengoChannel,
  normaliseTrengoEvent,
  type TrengoChannel,
  type TrengoEventName,
  type TrengoWebhookEnvelope,
} from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

export const trengoEventReceived = inngest.createFunction(
  {
    id: 'trengo/event.received',
    name: 'Process Trengo webhook event',
    concurrency: { limit: 10 },
    retries: 6,
  },
  { event: 'trengo/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId } = data

    const providerEvent = await step.run('load-event', async () => {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
      return row
    })
    const envelope = providerEvent.raw as unknown as TrengoWebhookEnvelope
    const eventName = normaliseTrengoEvent(envelope.event)
    if (!eventName) {
      logger.info({ eventId, type: envelope.event }, 'trengo event not recognised — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'unrecognised_event' }
    }

    const occurredAt = new Date(envelope.occurred_at)

    // Match → Contact / Family. CLAUDE.md §11.
    const match = await step.run('match', async () => matchTrengoEvent(envelope))

    // Outbound deliveries that we sent ourselves: skip — the outbound flow
    // already wrote the Interaction. We dedupe on the customFields hint.
    if (
      eventName === 'message.outbound' &&
      typeof envelope.data.custom_fields?.interactionId === 'string'
    ) {
      logger.info(
        { eventId, interactionId: envelope.data.custom_fields.interactionId },
        'trengo outbound mirrors an Interaction we created — skipping',
      )
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'self_sent_mirror' }
    }

    // Persist Interaction (idempotent on the Trengo eventId).
    const interaction = await step.run('upsert-interaction', async () => {
      return upsertTrengoInteraction({
        eventId,
        eventName,
        envelope,
        occurredAt,
        match,
      })
    })

    if (interaction.leadCreated && interaction.leadId) {
      await step.run('audit-lead', async () => {
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'lead.created',
          target: { type: 'Lead', id: interaction.leadId as string },
          requestId: eventId,
          after: {
            source: 'trengo',
            channel: envelope.data.channel ?? null,
            phone: envelope.data.contact?.phone ?? null,
            email: envelope.data.contact?.email ?? null,
          },
        })
      })
    }

    if (interaction.contactId || interaction.familyId) {
      await step.run('audit', async () => {
        await writeAuditLogEntry(db, {
          actorId: null,
          action: `trengo.${eventName}`,
          target: interaction.familyId
            ? { type: 'Family', id: interaction.familyId }
            : { type: 'Contact', id: interaction.contactId as string },
          requestId: eventId,
          after: { interactionId: interaction.id, eventName },
        })
      })
    }

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, interactionId: interaction.id }
  },
)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

interface TrengoMatch {
  contactId: string | null
  familyId: string | null
}

async function matchTrengoEvent(envelope: TrengoWebhookEnvelope): Promise<TrengoMatch> {
  const phone = envelope.data.contact?.phone?.trim() ?? null
  const email = envelope.data.contact?.email?.trim().toLowerCase() ?? null

  // Phone first (E.164). CLAUDE.md §11.
  if (phone && phone.startsWith('+')) {
    const byPhone = await db.contact.findFirst({
      where: { phoneE164: phone, deletedAt: null },
      select: { id: true, familyMembers: { select: { familyId: true } } },
    })
    if (byPhone) {
      return {
        contactId: byPhone.id,
        familyId: byPhone.familyMembers[0]?.familyId ?? null,
      }
    }
  }

  // Then email.
  if (email) {
    const byEmail = await db.contact.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, familyMembers: { select: { familyId: true } } },
    })
    if (byEmail) {
      return {
        contactId: byEmail.id,
        familyId: byEmail.familyMembers[0]?.familyId ?? null,
      }
    }
  }

  return { contactId: null, familyId: null }
}

interface UpsertTrengoInteractionInput {
  eventId: string
  eventName: TrengoEventName
  envelope: TrengoWebhookEnvelope
  occurredAt: Date
  match: TrengoMatch
}

interface UpsertTrengoInteractionResult {
  id: string
  contactId: string | null
  familyId: string | null
  leadCreated: boolean
  leadId: string | null
}

async function upsertTrengoInteraction(
  input: UpsertTrengoInteractionInput,
): Promise<UpsertTrengoInteractionResult> {
  // Idempotent on the Trengo eventId.
  const existing = await db.interaction.findFirst({
    where: {
      payload: { path: ['trengoEventId'], equals: input.eventId },
    },
    select: { id: true, contactId: true, familyId: true },
  })
  if (existing) {
    return {
      id: existing.id,
      contactId: existing.contactId,
      familyId: existing.familyId,
      leadCreated: false,
      leadId: null,
    }
  }

  const { contactId, familyId } = input.match
  let leadCreated = false
  let leadId: string | null = null

  // Inbound message with no Contact match → create a Lead. NEVER auto-create
  // a Contact (CLAUDE.md §11).
  const isInboundMessage = input.eventName === 'message.inbound'
  if (isInboundMessage && !contactId && !familyId) {
    const phone = input.envelope.data.contact?.phone?.trim() ?? null
    const email = input.envelope.data.contact?.email?.trim().toLowerCase() ?? null
    const created = await db.lead.create({
      data: {
        id: createId(),
        source: 'trengo',
        rawPayload: input.envelope as unknown as object,
        phoneE164: phone,
        email,
        name: input.envelope.data.contact?.name ?? null,
      },
      select: { id: true },
    })
    leadCreated = true
    leadId = created.id
  }

  const dbType = mapTrengoEventToDbType(input.eventName)
  const channel = (
    input.envelope.data.channel && isTrengoChannel(input.envelope.data.channel)
      ? input.envelope.data.channel
      : null
  ) as TrengoChannel | null

  const created = await db.interaction.create({
    data: {
      id: createId(),
      type: dbType,
      contactId,
      familyId,
      occurredAt: input.occurredAt,
      summary: buildSummary(input.eventName, channel),
      payload: {
        interactionType: input.eventName,
        trengoEventId: input.eventId,
        trengoEvent: input.envelope.event,
        ticketId: input.envelope.data.ticket_id ?? null,
        messageId: input.envelope.data.message_id ?? null,
        channel,
        body: input.envelope.data.body ?? null,
        ...(leadCreated ? { leadId } : {}),
      },
    },
    select: { id: true, contactId: true, familyId: true },
  })

  return {
    id: created.id,
    contactId: created.contactId,
    familyId: created.familyId,
    leadCreated,
    leadId,
  }
}

function mapTrengoEventToDbType(
  name: TrengoEventName,
):
  | 'message'
  | 'ticket_assigned'
  | 'ticket_closed'
  | 'ticket_reopened'
  | 'label_added'
  | 'label_removed' {
  switch (name) {
    case 'message.inbound':
    case 'message.outbound':
      return 'message'
    case 'ticket.assigned':
      return 'ticket_assigned'
    case 'ticket.closed':
      return 'ticket_closed'
    case 'ticket.reopened':
      return 'ticket_reopened'
    case 'label.added':
      return 'label_added'
    case 'label.removed':
      return 'label_removed'
  }
}

function buildSummary(name: TrengoEventName, channel: TrengoChannel | null): string {
  const ch = channel ?? 'message'
  switch (name) {
    case 'message.inbound':
      return `Inbound ${ch}`
    case 'message.outbound':
      return `Outbound ${ch}`
    case 'ticket.assigned':
      return 'Ticket assigned'
    case 'ticket.closed':
      return 'Ticket closed'
    case 'ticket.reopened':
      return 'Ticket reopened'
    case 'label.added':
      return 'Label added'
    case 'label.removed':
      return 'Label removed'
  }
}

// ADR 0017: 90-day historic backfill on first-connect.
import { BACKFILL_FUNCTIONS as TRENGO_BACKFILL_FUNCTIONS } from './backfill'

export const FUNCTIONS = [trengoEventReceived, ...TRENGO_BACKFILL_FUNCTIONS] as const
