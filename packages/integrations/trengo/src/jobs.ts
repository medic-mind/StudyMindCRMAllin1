// Trengo Inngest functions. CLAUDE.md §7.1, §11, §17.
//
// Inbound events match by phone (E.164) first, then email. If neither
// matches we create a Lead (NEVER a Contact — that path has been bitten by
// spam routes creating ghost Contacts in the past).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { applyEventToConversation } from './conversation-head'
import {
  buildContactSuggestionWrites,
  type TrengoContactProposal,
} from './contact-suggestions'
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

    // State changes (close / reopen) that the CRM initiated. Trengo's PATCH
    // endpoints do not accept custom_fields, so we look for a recent
    // CRM-sourced Interaction on the same ticket and link the trengoEventId
    // onto it rather than creating a duplicate. The window is bounded by
    // CRM_OUTBOUND_ECHO_WINDOW_MS so a future organic close on the same
    // ticket is not silently dropped.
    if (
      eventName === 'ticket.closed' ||
      eventName === 'ticket.reopened' ||
      eventName === 'ticket.assigned'
    ) {
      const ticketId = envelope.data.ticket_id
      if (typeof ticketId === 'number') {
        const echoType =
          eventName === 'ticket.closed'
            ? 'ticket_closed'
            : eventName === 'ticket.reopened'
              ? 'ticket_reopened'
              : 'ticket_assigned'
        const linked = await step.run('echo-skip-state', async () =>
          linkCrmOutboundEcho({
            ticketId,
            interactionType: echoType,
            trengoEventId: eventId,
          }),
        )
        if (linked) {
          await step.run('mark-processed', async () => {
            await db.providerEvent.update({
              where: { id: providerEventRowId },
              data: { processedAt: new Date() },
            })
          })
          return { skipped: true, reason: 'crm_outbound_echo', linkedTo: linked }
        }
      }
    }

    // ADR 0020 Phase 6c — `contact.updated` from Trengo. NEVER silently
    // applied to the Contact (CLAUDE.md §3). We write
    // ContactFieldSuggestion rows for any field that differs and let the
    // staff review queue surface them. Idempotent on (source, sourceEventId,
    // field). The event is its own terminal — it does NOT also become an
    // Interaction (the merger has no concept of contact-meta events).
    if (eventName === 'contact.updated') {
      let suggestionResult: { written: number; superseded: number } = {
        written: 0,
        superseded: 0,
      }
      if (match.contactId) {
        suggestionResult = await step.run('persist-suggestions', async () =>
          persistContactSuggestions({
            contactId: match.contactId as string,
            sourceEventId: eventId,
            proposal: {
              name: envelope.data.contact?.name ?? null,
              email: envelope.data.contact?.email ?? null,
              phone: envelope.data.contact?.phone ?? null,
            },
          }),
        )
        if (suggestionResult.written > 0) {
          await step.run('audit-suggestions', async () =>
            writeAuditLogEntry(db, {
              actorId: null,
              action: 'contact.suggestion_created',
              target: { type: 'Contact', id: match.contactId as string },
              requestId: eventId,
              after: {
                source: 'trengo',
                sourceEventId: eventId,
                written: suggestionResult.written,
                superseded: suggestionResult.superseded,
              },
            }),
          )
        }
      }
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return {
        ok: true,
        contactUpdatedSuggestions: suggestionResult.written,
        superseded: suggestionResult.superseded,
        matched: !!match.contactId,
      }
    }

    // Persist Interaction (idempotent on the Trengo eventId).
    // From here on we know eventName is NOT 'contact.updated' (it returned
    // above), so we can safely narrow for the helpers that don't model it.
    const interactionEventName = eventName as InteractionEventName
    const interaction = await step.run('upsert-interaction', async () => {
      return upsertTrengoInteraction({
        eventId,
        eventName: interactionEventName,
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

    // ADR 0020 Phase 6d — when a message arrived with attachments, fan
    // out to the download worker. We do NOT download inline because the
    // webhook handler must return 200 fast (CLAUDE.md §7.1). The worker
    // is idempotent on (interactionId, attachmentId).
    if (
      (eventName === 'message.inbound' || eventName === 'message.outbound') &&
      Array.isArray(envelope.data.attachments) &&
      envelope.data.attachments.length > 0
    ) {
      await step.sendEvent('enqueue-attachment-download', {
        name: 'trengo/download-attachments.requested',
        data: {
          interactionId: interaction.id,
          attachments: envelope.data.attachments,
        },
      })
    }

    // ADR 0020 Phase 2 — upsert the conversation head so the inbox and the
    // comms centre can answer "all unassigned open WhatsApp conversations"
    // with a single indexed query. Bodies stay in `Interaction`; this row is
    // the queryable state. We only upsert when the event carries a numeric
    // ticket id; otherwise there is nothing to key on.
    if (typeof envelope.data.ticket_id === 'number') {
      // Phase 6: resolve the raw Trengo assignee id to a CRM User if we have
      // the mapping (User.trengoUserId — stamped at token-connect time).
      const rawAssignee =
        typeof envelope.data.assignee_id === 'number'
          ? envelope.data.assignee_id
          : null
      let assigneeUserId: string | null = null
      if (rawAssignee !== null) {
        const u = await step.run('resolve-assignee', async () =>
          db.user.findUnique({
            where: { trengoUserId: rawAssignee },
            select: { id: true },
          }),
        )
        assigneeUserId = u?.id ?? null
      }

      await step.run('upsert-conversation-head', async () =>
        applyEventToConversation(db, {
          ticketId: envelope.data.ticket_id as number,
          eventName,
          occurredAt,
          channel: envelope.data.channel ?? null,
          contactId: match.contactId,
          familyId: match.familyId,
          trengoAssigneeId: rawAssignee,
          assigneeUserId,
          subject:
            typeof envelope.data['subject'] === 'string'
              ? (envelope.data['subject'] as string)
              : null,
          label: envelope.data.label?.name ?? null,
        }),
      )
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

/**
 * How long after a CRM-initiated state change we treat the matching Trengo
 * webhook as an echo of our own action. 5 minutes is generous for normal
 * latency while small enough that an organic close 10 minutes later is not
 * mistakenly suppressed.
 */
export const CRM_OUTBOUND_ECHO_WINDOW_MS = 5 * 60 * 1000

interface LinkEchoInput {
  ticketId: number
  interactionType: 'ticket_closed' | 'ticket_reopened' | 'ticket_assigned'
  trengoEventId: string
}

/**
 * Look for a CRM-sourced Interaction (source = 'crm_outbound') on the same
 * ticket within the echo window. If found, stamp the trengoEventId onto its
 * payload and return its id so the caller can short-circuit. Returns null when
 * the event is organic (Trengo user closed/reopened in Trengo itself) and the
 * normal upsert path should run.
 */
async function linkCrmOutboundEcho(input: LinkEchoInput): Promise<string | null> {
  const since = new Date(Date.now() - CRM_OUTBOUND_ECHO_WINDOW_MS)
  const candidate = await db.interaction.findFirst({
    where: {
      type: input.interactionType,
      occurredAt: { gte: since },
      AND: [
        { payload: { path: ['ticketId'], equals: input.ticketId } },
        { payload: { path: ['source'], equals: 'crm_outbound' } },
      ],
    },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, payload: true },
  })
  if (!candidate) return null
  const payload = (candidate.payload ?? {}) as Record<string, unknown>
  // Already linked to a Trengo event id — keep it stable.
  if (typeof payload['trengoEventId'] === 'string') return candidate.id
  await db.interaction.update({
    where: { id: candidate.id },
    data: { payload: { ...payload, trengoEventId: input.trengoEventId } },
  })
  return candidate.id
}

interface PersistContactSuggestionsInput {
  contactId: string
  sourceEventId: string
  proposal: TrengoContactProposal
}

/**
 * Diff the proposal against the current Contact and persist a row per
 * differing field. Marks any previously-pending suggestion for the same
 * (contactId, field) as `superseded` so the queue never shows stale
 * proposals against a newer one. Idempotent on (source, sourceEventId,
 * field) — a webhook replay returns the same set of rows.
 */
async function persistContactSuggestions(
  input: PersistContactSuggestionsInput,
): Promise<{ written: number; superseded: number }> {
  const current = await db.contact.findUnique({
    where: { id: input.contactId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneE164: true,
    },
  })
  if (!current) return { written: 0, superseded: 0 }

  const writes = buildContactSuggestionWrites({
    current,
    proposal: input.proposal,
    sourceEventId: input.sourceEventId,
  })
  if (writes.length === 0) return { written: 0, superseded: 0 }

  // Supersede older pending suggestions for the same (contactId, field).
  // We do this BEFORE the upsert so the queue never briefly shows two
  // pending rows for the same field.
  const supersede = await db.contactFieldSuggestion.updateMany({
    where: {
      contactId: input.contactId,
      field: { in: writes.map((w) => w.field) },
      status: 'pending',
      // Don't touch the rows we are about to upsert (idempotent replay).
      NOT: {
        AND: [
          { source: 'trengo' },
          { sourceEventId: input.sourceEventId },
        ],
      },
    },
    data: { status: 'superseded', updatedAt: new Date() },
  })

  // Upsert each write idempotently on the unique key.
  for (const w of writes) {
    await db.contactFieldSuggestion.upsert({
      where: {
        source_sourceEventId_field: {
          source: w.source,
          sourceEventId: w.sourceEventId,
          field: w.field,
        },
      },
      create: {
        id: w.id,
        contactId: w.contactId,
        source: w.source,
        sourceEventId: w.sourceEventId,
        field: w.field,
        proposedValue: w.proposedValue,
        currentValue: w.currentValue,
      },
      // A replay should NOT change `currentValue` — that was captured at
      // first sight. The proposed value is also stable for a given event,
      // so the update is effectively a no-op touch of `updatedAt`.
      update: { updatedAt: new Date() },
    })
  }

  return { written: writes.length, superseded: supersede.count }
}

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
  /** `contact.updated` is its own terminal branch above and never reaches
   *  this upsert, so we narrow the type to make the downstream switches
   *  exhaustive at compile time. */
  eventName: InteractionEventName
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

// `contact.updated` is handled in its own branch (it never becomes an
// Interaction), so these helpers narrow the input to the Interaction-bound
// subset of event names — the switch stays exhaustive at compile time.
type InteractionEventName = Exclude<TrengoEventName, 'contact.updated'>

function mapTrengoEventToDbType(
  name: InteractionEventName,
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

function buildSummary(name: InteractionEventName, channel: TrengoChannel | null): string {
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
// ADR 0020 Phase 2c: one-shot Conversation-head backfill from existing
// Interactions. Triggered via admin.backfill.conversationHeads.start; runs
// once per environment.
import { backfillConversationHeads } from './backfill-conversation-heads'
// ADR 0020 Phase 7a: outbound retry queue. 5-minute cron sweeps any
// Interaction still in `pending_send` and re-attempts via the same audited
// outbound. TOKEN_EXPIRED rows are not retried — the agent must reconnect.
import { trengoRetryPendingSend } from './retry-pending'
// ADR 0020 Phase 6d: attachment download worker. Fired when a message
// webhook carries an attachments array; idempotent on (interactionId,
// attachmentId). Uploads via SSE:KMS to S3.
import { trengoDownloadAttachments } from './attachments'

export const FUNCTIONS = [
  trengoEventReceived,
  backfillConversationHeads,
  trengoRetryPendingSend,
  trengoDownloadAttachments,
  ...TRENGO_BACKFILL_FUNCTIONS,
] as const
