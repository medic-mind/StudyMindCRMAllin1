// Outbound calls TO Trengo. CLAUDE.md §11.
//
// We persist a `pending_send` Interaction first, then call Trengo. On success
// the Interaction transitions to `sent`. On failure (including TOKEN_EXPIRED)
// the row stays `pending_send` with an error reason so an agent can retry,
// and we surface the error back to the caller. We never fall back to a
// shared token on TOKEN_EXPIRED — that would break agent attribution.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { BusinessError } from '@studymind/core'
import { db } from '@studymind/db'

import { createClientForAgent, TrengoApiError } from './client'
import { applyEventToConversation } from './conversation-head'
import type { TrengoChannel } from './types'

export interface OutboundAttachment {
  filename: string
  contentType: string
  data: Buffer
}

export interface SendMessageInput {
  contactId: string
  agentId: string
  ticketId: number
  channel: TrengoChannel
  body: string
  requestId: string
  /** Files to upload + attach. Each is uploaded via Trengo `/media` first,
   *  then the resulting ids are attached to the message. */
  attachments?: OutboundAttachment[]
}

export interface SendMessageResult {
  interactionId: string
  trengoMessageId: number | null
}

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  // 1. Persist the Interaction in pending_send first. Idempotency: same
  //    (agentId, ticketId, requestId) tuple yields the same Interaction id.
  const existing = await db.interaction.findFirst({
    where: {
      type: 'message',
      contactId: input.contactId,
      payload: {
        path: ['outboundRequestId'],
        equals: input.requestId,
      },
    },
    select: { id: true, payload: true },
  })

  let interactionId: string
  if (existing) {
    interactionId = existing.id
    // Already delivered on a prior attempt — do NOT call Trengo again. Trengo's
    // message API has no idempotency key, so re-sending (e.g. the retry cron
    // re-running a row whose send succeeded but whose status update didn't)
    // would double-message the customer. Only pending_send rows are re-sent.
    const p = (existing.payload ?? {}) as Record<string, unknown>
    if (p['status'] === 'sent' || p['trengoMessageId'] != null) {
      return {
        interactionId,
        trengoMessageId: typeof p['trengoMessageId'] === 'number' ? p['trengoMessageId'] : null,
      }
    }
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: 'message',
        contactId: input.contactId,
        occurredAt: new Date(),
        summary: `Outbound ${input.channel} (sending)`,
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: 'message.outbound',
          status: 'pending_send',
          channel: input.channel,
          ticketId: input.ticketId,
          agentId: input.agentId,
          body: input.body,
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  // 2. Build the per-agent client. Throws BusinessError('TOKEN_EXPIRED')
  //    fail-closed if the agent's token is missing or expired.
  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: 'trengo.outbound',
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  // 3. Send. On failure, leave the Interaction in pending_send and rethrow.
  try {
    // Text first (documented `message` param), then one media message per
    // file via the documented `/tickets/:id/messages/media` — the same two
    // requests Trengo's own composer makes. An attachment-only send skips
    // the empty text message.
    let message: { id: number | null } | null = null
    if (input.body.trim() !== '') {
      message = await client.sendMessage({
        ticketId: input.ticketId,
        body: input.body,
        channel: input.channel,
        customFields: {
          // Per CLAUDE.md §11 — embed our Interaction id and agent id so
          // inbound webhook events for this message reconcile cleanly.
          interactionId,
          agentId: input.agentId,
        },
      })
    }
    const attachmentMeta: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      trengoMessageId: number | null
    }> = []
    for (const att of input.attachments ?? []) {
      const sent = await client.sendMediaMessage({
        ticketId: input.ticketId,
        filename: att.filename,
        contentType: att.contentType,
        data: att.data,
      })
      attachmentMeta.push({
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.data.byteLength,
        trengoMessageId: sent.id,
      })
      if (!message) message = sent
    }

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        summary: `Outbound ${input.channel} sent`,
        payload: {
          interactionType: 'message.outbound',
          status: 'sent',
          channel: input.channel,
          ticketId: input.ticketId,
          agentId: input.agentId,
          body: input.body,
          outboundRequestId: input.requestId,
          trengoMessageId: message?.id ?? null,
          ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action: 'trengo.message_sent',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: {
        interactionId,
        trengoMessageId: message?.id ?? null,
        channel: input.channel,
      },
    })

    // ADR 0020 Phase 2 — mirror the outbound onto the conversation head
    // immediately. The Trengo webhook for our own outbound is echo-skipped
    // (jobs.ts self_sent_mirror) so without this the head would never see
    // our clear-unread / lastOutboundAt update.
    await applyEventToConversation(db, {
      ticketId: input.ticketId,
      eventName: 'message.outbound',
      occurredAt: new Date(),
      channel: input.channel,
      contactId: input.contactId,
      preview: input.body,
    })

    return { interactionId, trengoMessageId: message?.id ?? null }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Start a new conversation — ADR 0020 Phase 6j.
//
// First outbound to a contact who has no open ticket. Creates the Trengo
// conversation (ticket) + first message, then mirrors a Conversation head so
// it appears in the inbox at once. Two-phase like sendMessage: the
// Interaction is persisted `pending_send` first; on Trengo failure it stays
// pending and the retry cron picks it up. The custom_fields carry our
// Interaction id so the echoed webhook reconciles (no duplicate).
// -----------------------------------------------------------------------------

export interface StartConversationInput {
  contactId: string
  agentId: string
  channel: TrengoChannel
  /** Exact Trengo channel (sender line) to send from — see
   *  TrengoCreateConversationInput.channelId. */
  trengoChannelId?: number
  /** E.164 phone (whatsapp/sms) or email address (email). */
  recipient: string
  body: string
  requestId: string
  /** Files to upload + attach to the first message (uploaded via Trengo
   *  `/media` first, then attached by id). */
  attachments?: OutboundAttachment[]
}

export interface StartConversationResult {
  interactionId: string
  ticketId: number
  trengoMessageId: number | null
}

export async function startConversation(
  input: StartConversationInput,
): Promise<StartConversationResult> {
  const existing = await db.interaction.findFirst({
    where: {
      type: 'message',
      contactId: input.contactId,
      payload: { path: ['outboundRequestId'], equals: input.requestId },
    },
    select: { id: true, payload: true },
  })

  let interactionId: string
  if (existing) {
    interactionId = existing.id
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: 'message',
        contactId: input.contactId,
        occurredAt: new Date(),
        summary: `New ${input.channel} conversation (sending)`,
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: 'message.outbound',
          status: 'pending_send',
          channel: input.channel,
          agentId: input.agentId,
          body: input.body,
          recipient: input.recipient,
          newConversation: true,
          ...(input.trengoChannelId ? { trengoChannelId: input.trengoChannelId } : {}),
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: 'trengo.start_conversation',
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  try {
    const result = await client.createConversation({
      channel: input.channel,
      recipient: input.recipient,
      body: input.body,
      customFields: { interactionId, agentId: input.agentId },
      ...(input.trengoChannelId ? { channelId: input.trengoChannelId } : {}),
    })
    if (!result.ticketId) {
      throw new TrengoApiError(502, '/messages', { reason: 'no ticket id returned' })
    }

    // Attachments follow as media messages on the freshly-created ticket
    // (documented `/tickets/:id/messages/media`, one file per message).
    const attachmentMeta: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      trengoMessageId: number | null
    }> = []
    for (const att of input.attachments ?? []) {
      const sent = await client.sendMediaMessage({
        ticketId: result.ticketId,
        filename: att.filename,
        contentType: att.contentType,
        data: att.data,
      })
      attachmentMeta.push({
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.data.byteLength,
        trengoMessageId: sent.id,
      })
    }

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        summary: `New ${input.channel} conversation sent`,
        payload: {
          interactionType: 'message.outbound',
          status: 'sent',
          channel: input.channel,
          ticketId: result.ticketId,
          agentId: input.agentId,
          body: input.body,
          recipient: input.recipient,
          newConversation: true,
          outboundRequestId: input.requestId,
          trengoMessageId: result.messageId,
          ...(attachmentMeta.length > 0 ? { attachments: attachmentMeta } : {}),
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action: 'trengo.message_sent',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: {
        interactionId,
        ticketId: result.ticketId,
        channel: input.channel,
        newConversation: true,
      },
    })

    // Mirror a head so the new conversation shows in the inbox immediately.
    await applyEventToConversation(db, {
      ticketId: result.ticketId,
      eventName: 'message.outbound',
      occurredAt: new Date(),
      channel: input.channel,
      contactId: input.contactId,
      preview: input.body,
    })

    return {
      interactionId,
      ticketId: result.ticketId,
      trengoMessageId: result.messageId,
    }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Standalone send — a message to a raw recipient (E.164 phone / email) with NO
// CRM Contact behind it (ADR 0045 amendment: the Direct Debit collections
// system chases people who predate the CRM, so a case can have just a name +
// phone). We still go through the per-agent token (§11) and audit the send, but
// write no contact-scoped Interaction or Conversation head — the caller (a
// DdCaseMessage row) owns the record. Prefer `startConversation` whenever a
// contactId exists, so the message reflects on that customer's timeline.
// -----------------------------------------------------------------------------

export interface SendStandaloneMessageInput {
  agentId: string
  channel: TrengoChannel
  /** E.164 phone (sms/whatsapp) or email address (email). */
  recipient: string
  body: string
  requestId: string
  /** Exact Trengo channel (sender line) to send from. */
  trengoChannelId?: number
  /** Audit target — defaults to a DirectDebitCase keyed on the recipient. */
  auditTarget?: { type: string; id: string }
}

export interface SendStandaloneMessageResult {
  ticketId: number | null
  trengoMessageId: number | null
}

export async function sendStandaloneMessage(
  input: SendStandaloneMessageInput,
): Promise<SendStandaloneMessageResult> {
  const client = await createClientForAgent({
    agentId: input.agentId,
    requestId: input.requestId,
    purpose: 'trengo.start_conversation',
  })
  const result = await client.createConversation({
    channel: input.channel,
    recipient: input.recipient,
    body: input.body,
    customFields: { agentId: input.agentId },
    ...(input.trengoChannelId ? { channelId: input.trengoChannelId } : {}),
  })
  if (!result.ticketId) {
    throw new TrengoApiError(502, '/messages', { reason: 'no ticket id returned' })
  }
  await writeAuditLogEntry(db, {
    actorId: input.agentId,
    action: 'trengo.message_sent',
    target: input.auditTarget ?? { type: 'DirectDebitCase', id: input.recipient },
    requestId: input.requestId,
    after: { ticketId: result.ticketId, channel: input.channel, standalone: true },
  })
  return { ticketId: result.ticketId, trengoMessageId: result.messageId }
}

// -----------------------------------------------------------------------------
// WhatsApp (HSM) templates — list + send.
//
// The approved templates live in Trengo (they carry the info-pack links the
// team already uses); we surface them in the CRM call-summary flow "just as
// they would on Trengo". Listing is read-only per-agent; sending goes through
// /wa_sessions so it is valid outside the 24-hour window, with the same
// two-phase pending_send Interaction as every other Trengo outbound.
// -----------------------------------------------------------------------------

export interface WhatsAppTemplate {
  id: number
  title: string
  body: string
  /** The {{n}} placeholder keys found in the body, in order ("{{1}}", …). */
  params: string[]
}

/** Extract the {{n}} placeholders from a template body, deduped, in order. */
export function extractWaTemplateParams(body: string): string[] {
  const seen = new Set<string>()
  for (const match of body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    seen.add(`{{${match[1]}}}`)
  }
  return [...seen]
}

export async function listWhatsAppTemplates(
  agentId: string,
  requestId: string,
): Promise<WhatsAppTemplate[]> {
  const client = await createClientForAgent({
    agentId,
    requestId,
    purpose: 'trengo.list_wa_templates',
  })
  const rows = await client.listWaTemplates()
  return rows
    .filter((r) => {
      // Only templates WhatsApp has approved are sendable; keep rows whose
      // status is missing (older Trengo versions omit it) or approved-ish.
      const status = (r.status ?? '').toLowerCase()
      return status === '' || status === 'approved' || status === 'accepted' || status === 'active'
    })
    .map((r) => {
      const body = r.message ?? r.body ?? r.content ?? ''
      return {
        id: r.id,
        title: r.title ?? r.name ?? `Template ${r.id}`,
        body,
        params: extractWaTemplateParams(body),
      }
    })
    .filter((t) => t.body.trim().length > 0)
}

export interface SendWhatsAppTemplateInput {
  contactId: string
  agentId: string
  /** E.164 recipient phone. */
  recipient: string
  templateId: number
  templateTitle: string
  /** The template body with params substituted — what the customer reads.
   *  Persisted on the timeline Interaction. */
  renderedBody: string
  params: Array<{ key: string; value: string }>
  requestId: string
}

export interface SendWhatsAppTemplateResult {
  interactionId: string
  ticketId: number | null
  trengoMessageId: number | null
}

export async function sendWhatsAppTemplate(
  input: SendWhatsAppTemplateInput,
): Promise<SendWhatsAppTemplateResult> {
  // Idempotency: same (contactId, requestId) tuple yields the same Interaction.
  const existing = await db.interaction.findFirst({
    where: {
      type: 'message',
      contactId: input.contactId,
      payload: { path: ['outboundRequestId'], equals: input.requestId },
    },
    select: { id: true },
  })

  let interactionId: string
  if (existing) {
    interactionId = existing.id
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: 'message',
        contactId: input.contactId,
        occurredAt: new Date(),
        summary: `Outbound whatsapp template (sending)`,
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: 'message.outbound',
          status: 'pending_send',
          channel: 'whatsapp',
          agentId: input.agentId,
          body: input.renderedBody,
          recipient: input.recipient,
          waTemplate: {
            id: input.templateId,
            title: input.templateTitle,
            params: input.params.map((p) => ({ key: p.key, value: p.value })),
          },
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: 'trengo.send_wa_template',
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  try {
    const result = await client.sendWaTemplate({
      recipientPhone: input.recipient,
      templateId: input.templateId,
      params: input.params,
    })

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        summary: `Outbound whatsapp template sent (${input.templateTitle})`,
        payload: {
          interactionType: 'message.outbound',
          status: 'sent',
          channel: 'whatsapp',
          agentId: input.agentId,
          body: input.renderedBody,
          recipient: input.recipient,
          waTemplate: {
            id: input.templateId,
            title: input.templateTitle,
            params: input.params.map((p) => ({ key: p.key, value: p.value })),
          },
          outboundRequestId: input.requestId,
          ...(result.ticketId != null ? { ticketId: result.ticketId } : {}),
          ...(result.messageId != null ? { trengoMessageId: result.messageId } : {}),
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action: 'trengo.message_sent',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: {
        interactionId,
        channel: 'whatsapp',
        waTemplateId: input.templateId,
        ...(result.ticketId != null ? { ticketId: result.ticketId } : {}),
        ...(result.messageId != null ? { trengoMessageId: result.messageId } : {}),
      },
    })

    // Mirror the conversation head when Trengo told us which ticket the
    // session landed on, so the thread shows in the inbox immediately.
    if (result.ticketId != null) {
      await applyEventToConversation(db, {
        ticketId: result.ticketId,
        eventName: 'message.outbound',
        occurredAt: new Date(),
        channel: 'whatsapp',
        contactId: input.contactId,
      })
    }

    return {
      interactionId,
      ticketId: result.ticketId,
      trengoMessageId: result.messageId,
    }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Ticket state changes — close / reopen.
//
// Trengo's PATCH /tickets/:id/{close,reopen} endpoints do not accept
// custom_fields, so we cannot use the same "interactionId echo-skip" path that
// sendMessage uses for messages. Instead we write a `ticket_closed` /
// `ticket_reopened` Interaction with `payload.source = 'crm_outbound'` and the
// originating requestId; the webhook job (jobs.ts) recognises that marker and
// links the inbound webhook event to the existing row rather than creating a
// duplicate. CLAUDE.md §11.
// -----------------------------------------------------------------------------

export type TicketStateAction = 'close' | 'reopen'

export interface ChangeTicketStateInput {
  /** The CRM Contact whose conversation we are acting on. */
  contactId: string
  agentId: string
  ticketId: number
  action: TicketStateAction
  requestId: string
}

export interface ChangeTicketStateResult {
  interactionId: string
  ticketId: number
  action: TicketStateAction
}

export async function closeConversation(
  input: Omit<ChangeTicketStateInput, 'action'>,
): Promise<ChangeTicketStateResult> {
  return changeTicketState({ ...input, action: 'close' })
}

export async function reopenConversation(
  input: Omit<ChangeTicketStateInput, 'action'>,
): Promise<ChangeTicketStateResult> {
  return changeTicketState({ ...input, action: 'reopen' })
}

async function changeTicketState(
  input: ChangeTicketStateInput,
): Promise<ChangeTicketStateResult> {
  const interactionType =
    input.action === 'close' ? 'ticket_closed' : 'ticket_reopened'
  const eventName = input.action === 'close' ? 'ticket.closed' : 'ticket.reopened'
  const summary =
    input.action === 'close' ? 'Conversation closed' : 'Conversation reopened'

  // 1. Idempotency: same (contactId, ticketId, requestId, action) tuple yields
  //    the same Interaction id. Retries do not double-write.
  const existing = await db.interaction.findFirst({
    where: {
      type: interactionType,
      contactId: input.contactId,
      payload: { path: ['outboundRequestId'], equals: input.requestId },
    },
    select: { id: true },
  })

  let interactionId: string
  if (existing) {
    interactionId = existing.id
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: interactionType,
        contactId: input.contactId,
        occurredAt: new Date(),
        summary,
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: eventName,
          source: 'crm_outbound',
          status: 'pending_send',
          ticketId: input.ticketId,
          agentId: input.agentId,
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  // 2. Per-agent client. Fail-closed on TOKEN_EXPIRED (CLAUDE.md §11).
  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: `trengo.${input.action}`,
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  // 3. Issue the state change. On failure, leave the Interaction in
  //    pending_send so an agent can retry from the inline error banner.
  try {
    const ticket =
      input.action === 'close'
        ? await client.closeTicket(input.ticketId)
        : await client.reopenTicket(input.ticketId)

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        payload: {
          interactionType: eventName,
          source: 'crm_outbound',
          status: 'sent',
          ticketId: input.ticketId,
          agentId: input.agentId,
          outboundRequestId: input.requestId,
          trengoTicketStatus: ticket.status,
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action:
        input.action === 'close'
          ? 'trengo.ticket_close_requested'
          : 'trengo.ticket_reopen_requested',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: { interactionId, ticketId: input.ticketId, trengoStatus: ticket.status },
    })

    // ADR 0020 Phase 2 — mirror onto the conversation head. The webhook for
    // this state change is echo-skipped (jobs.ts linkCrmOutboundEcho) so the
    // head would otherwise miss our action.
    await applyEventToConversation(db, {
      ticketId: input.ticketId,
      eventName: eventName,
      occurredAt: new Date(),
      contactId: input.contactId,
    })

    return { interactionId, ticketId: input.ticketId, action: input.action }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Assignment — ADR 0020 Phase 6e.
//
// Resolves the target CRM User to their Trengo numeric id (User.trengoUserId
// — stamped at token-connect in Phase 6a), persists a CRM-sourced
// `ticket_assigned` Interaction with `source: 'crm_outbound'`, calls Trengo's
// PATCH /tickets/:id/assign, and mirrors onto the Conversation head. The
// inbound `ticket.assigned` echo is folded back onto our row by
// `linkCrmOutboundEcho` in jobs.ts.
//
// Refuses (BAD_INPUT) when the target user has no Trengo identity — Trengo
// would reject the PATCH and we'd waste a request.
// -----------------------------------------------------------------------------

export interface AssignConversationInput {
  contactId: string
  /** The CRM agent performing the action — used for token + attribution. */
  agentId: string
  ticketId: number
  /** Target Trengo agent id (from the TrengoUser mirror) — lets the CRM
   *  assign to ANY Trengo agent, not only CRM users who connected a token. */
  trengoAssigneeId: number
  requestId: string
}

export interface AssignConversationResult {
  interactionId: string
  ticketId: number
  /** Linked CRM user id, when the Trengo agent also logs into the CRM. */
  assigneeUserId: string | null
  trengoAssigneeId: number
}

export async function assignConversation(
  input: AssignConversationInput,
): Promise<AssignConversationResult> {
  // 1. Assign by the Trengo agent id directly. Resolve the linked CRM user
  //    (mirror → User.trengoUserId) so the head can show a CRM name when the
  //    agent also logs into the CRM; null is fine for Trengo-only agents.
  const trengoAssigneeId = input.trengoAssigneeId
  const mirror = await db.trengoUser.findUnique({
    where: { trengoUserId: trengoAssigneeId },
    select: { crmUserId: true },
  })
  let assigneeUserId: string | null = mirror?.crmUserId ?? null
  if (!assigneeUserId) {
    const u = await db.user.findUnique({
      where: { trengoUserId: trengoAssigneeId },
      select: { id: true },
    })
    assigneeUserId = u?.id ?? null
  }

  // 2. Persist the CRM-sourced Interaction first. Idempotent on requestId.
  const existing = await db.interaction.findFirst({
    where: {
      type: 'ticket_assigned',
      contactId: input.contactId,
      payload: { path: ['outboundRequestId'], equals: input.requestId },
    },
    select: { id: true },
  })

  let interactionId: string
  if (existing) {
    interactionId = existing.id
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: 'ticket_assigned',
        contactId: input.contactId,
        occurredAt: new Date(),
        summary: 'Conversation assigned',
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: 'ticket.assigned',
          source: 'crm_outbound',
          status: 'pending_send',
          ticketId: input.ticketId,
          agentId: input.agentId,
          assigneeUserId,
          trengoAssigneeId,
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  // 3. Per-agent client. Fail-closed on TOKEN_EXPIRED.
  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: 'trengo.assign',
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  // 4. Issue the assignment. On failure, leave the Interaction in
  //    pending_send so the cron retry queue (Phase 7a) picks it up.
  try {
    const ticket = await client.assignTicket(input.ticketId, trengoAssigneeId)

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        payload: {
          interactionType: 'ticket.assigned',
          source: 'crm_outbound',
          status: 'sent',
          ticketId: input.ticketId,
          agentId: input.agentId,
          assigneeUserId,
          trengoAssigneeId,
          outboundRequestId: input.requestId,
          trengoTicketStatus: ticket.status,
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action: 'trengo.ticket_assign_requested',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: {
        interactionId,
        ticketId: input.ticketId,
        assigneeUserId,
        trengoAssigneeId,
      },
    })

    await applyEventToConversation(db, {
      ticketId: input.ticketId,
      eventName: 'ticket.assigned',
      occurredAt: new Date(),
      contactId: input.contactId,
      assigneeUserId,
      trengoAssigneeId,
    })

    return {
      interactionId,
      ticketId: input.ticketId,
      assigneeUserId,
      trengoAssigneeId,
    }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Labels (tags) — add / remove on a conversation. ADR 0020 Phase 6f.
//
// Completes the bi-directional tag sync the brief asked for: inbound
// label.added / label.removed already flow into Conversation.tags; these push
// a CRM-side add/remove back to Trengo. Label catalogue is resolved by name
// (Conversation.tags stores names); an unknown name is created (the brief's
// "Creation"). The webhook echo of our own change is folded back by
// linkCrmOutboundEcho so the timeline never doubles up.
// -----------------------------------------------------------------------------

export interface ConversationLabelInput {
  contactId: string
  agentId: string
  ticketId: number
  /** Label NAME (what Conversation.tags stores). */
  label: string
  requestId: string
}

export interface ConversationLabelResult {
  interactionId: string
  ticketId: number
  label: string
  labelId: number
}

export async function addConversationLabel(
  input: ConversationLabelInput,
): Promise<ConversationLabelResult> {
  return changeConversationLabel(input, 'add')
}

export async function removeConversationLabel(
  input: ConversationLabelInput,
): Promise<ConversationLabelResult> {
  return changeConversationLabel(input, 'remove')
}

async function changeConversationLabel(
  input: ConversationLabelInput,
  action: 'add' | 'remove',
): Promise<ConversationLabelResult> {
  const interactionType = action === 'add' ? 'label_added' : 'label_removed'
  const eventName = action === 'add' ? 'label.added' : 'label.removed'
  const summary = action === 'add' ? `Label added: ${input.label}` : `Label removed: ${input.label}`

  // Idempotent on (contactId, type, requestId).
  const existing = await db.interaction.findFirst({
    where: {
      type: interactionType,
      contactId: input.contactId,
      payload: { path: ['outboundRequestId'], equals: input.requestId },
    },
    select: { id: true },
  })
  let interactionId: string
  if (existing) {
    interactionId = existing.id
  } else {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: interactionType,
        contactId: input.contactId,
        occurredAt: new Date(),
        summary,
        createdById: input.agentId,
        updatedById: input.agentId,
        payload: {
          interactionType: eventName,
          source: 'crm_outbound',
          status: 'pending_send',
          ticketId: input.ticketId,
          agentId: input.agentId,
          label: input.label,
          outboundRequestId: input.requestId,
        },
      },
      select: { id: true },
    })
    interactionId = created.id
  }

  let client
  try {
    client = await createClientForAgent({
      agentId: input.agentId,
      requestId: input.requestId,
      purpose: `trengo.label_${action}`,
    })
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }

  try {
    // Resolve the label name → id. On add, create the label if Trengo does
    // not have it yet (the brief's "Creation"). On remove, a missing label
    // is a no-op success (nothing to detach).
    const labels = await client.listLabels()
    const match = labels.find(
      (l) => l.name.trim().toLowerCase() === input.label.trim().toLowerCase(),
    )
    let labelId: number
    if (match) {
      labelId = match.id
    } else if (action === 'add') {
      const created = await client.createLabel(input.label.trim())
      labelId = created.id
    } else {
      labelId = 0 // nothing to detach; treat as success
    }

    if (action === 'add') {
      await client.attachLabel(input.ticketId, labelId)
    } else if (labelId > 0) {
      await client.detachLabel(input.ticketId, labelId)
    }

    await db.interaction.update({
      where: { id: interactionId },
      data: {
        payload: {
          interactionType: eventName,
          source: 'crm_outbound',
          status: 'sent',
          ticketId: input.ticketId,
          agentId: input.agentId,
          label: input.label,
          labelId,
          outboundRequestId: input.requestId,
        },
      },
    })

    await writeAuditLogEntry(db, {
      actorId: input.agentId,
      action: action === 'add' ? 'trengo.label_add_requested' : 'trengo.label_remove_requested',
      target: { type: 'Contact', id: input.contactId },
      requestId: input.requestId,
      after: { interactionId, ticketId: input.ticketId, label: input.label, labelId },
    })

    // Mirror onto the conversation head (tags array). The webhook echo is
    // skipped (jobs.ts linkCrmOutboundEcho) so this is the head's only update.
    await applyEventToConversation(db, {
      ticketId: input.ticketId,
      eventName,
      occurredAt: new Date(),
      contactId: input.contactId,
      label: input.label,
    })

    return { interactionId, ticketId: input.ticketId, label: input.label, labelId }
  } catch (err) {
    await markFailed(interactionId, err)
    throw err
  }
}

// -----------------------------------------------------------------------------
// Internal notes — push a team-only note to Trengo. ADR 0020 Phase 6f.
//
// The note's CRM source of truth is written by the unified notes path
// (inbox.conversations.notes.add — which also handles @mentions and works for
// every conversation, not just Trengo). This helper is the thin Trengo-side
// push: it builds the per-agent client and posts to the internal-notes
// endpoint. The caller treats failure as best-effort (the note is already
// saved CRM-side), so this stays a plain throw-on-failure call.
// -----------------------------------------------------------------------------

export interface PushInternalNoteInput {
  agentId: string
  ticketId: number
  body: string
  requestId: string
}

export async function pushInternalNoteToTrengo(
  input: PushInternalNoteInput,
): Promise<{ trengoNoteId: number }> {
  const client = await createClientForAgent({
    agentId: input.agentId,
    requestId: input.requestId,
    purpose: 'trengo.note',
  })
  const note = await client.addInternalNote(input.ticketId, input.body)
  return { trengoNoteId: note.id }
}

/** Fetch the agent's Trengo label catalogue (for the label picker). */
export async function listTrengoLabels(
  agentId: string,
  requestId: string,
): Promise<Array<{ id: number; name: string; color: string | null }>> {
  const client = await createClientForAgent({
    agentId,
    requestId,
    purpose: 'trengo.labels.list',
  })
  const labels = await client.listLabels()
  return labels.map((l) => ({ id: l.id, name: l.name, color: l.color ?? null }))
}

async function markFailed(interactionId: string, err: unknown): Promise<void> {
  const reason =
    err instanceof BusinessError
      ? { code: err.code, message: err.message }
      : err instanceof TrengoApiError
        ? { code: 'TRENGO_API_ERROR', status: err.status, message: err.message }
        : { code: 'UNKNOWN', message: err instanceof Error ? err.message : String(err) }

  const row = await db.interaction.findUnique({
    where: { id: interactionId },
    select: { payload: true, summary: true },
  })
  const existingPayload = (row?.payload as Record<string, unknown> | null) ?? {}

  // Make the failure VISIBLE: the summary is what every list/timeline shows,
  // and "(sending)" forever was indistinguishable from a hung send. Status
  // stays `pending_send` so the retry cron still picks the row up — the
  // summary flips back to "… sent" if a later attempt succeeds.
  const failedSummary = row?.summary
    ? row.summary
        .replace(/\((sending|failed[^)]*)\)\s*$/i, '')
        .trimEnd()
        .concat(' (failed — will retry)')
    : null

  await db.interaction.update({
    where: { id: interactionId },
    data: {
      ...(failedSummary ? { summary: failedSummary } : {}),
      payload: {
        ...existingPayload,
        status: 'pending_send',
        lastError: reason,
        lastErrorAt: new Date().toISOString(),
      },
    },
  })
}

// -----------------------------------------------------------------------------
// Quick replies — Trengo's canned responses, used as the SMS "templates"
// (WhatsApp has the approved HSM templates above; SMS has no platform
// template requirement, so Trengo's own quick-reply catalogue is the
// equivalent the team already maintains in Trengo).
// -----------------------------------------------------------------------------

export interface TrengoQuickReply {
  id: number
  title: string
  body: string
}

export async function listTrengoQuickReplies(
  agentId: string,
  requestId: string,
): Promise<TrengoQuickReply[]> {
  const client = await createClientForAgent({
    agentId,
    requestId,
    purpose: 'trengo.list_quick_replies',
  })
  const rows = await client.listQuickReplies()
  return rows
    .map((r) => ({
      id: r.id,
      title: r.title ?? r.name ?? `Quick reply ${r.id}`,
      body: r.message ?? r.body ?? '',
    }))
    .filter((r) => r.body.trim().length > 0)
}


// -----------------------------------------------------------------------------
// Workspace channels — for the composer's "send from" picker. Graceful like
// listTrengoQuickReplies: a missing/expired token yields available:false so
// the UI falls back to the workspace default instead of erroring.
// -----------------------------------------------------------------------------

const CHANNEL_KIND_BY_TYPE: Record<string, TrengoChannel> = {
  WA_BUSINESS: 'whatsapp',
  WHATSAPP: 'whatsapp',
  SMS: 'sms',
  EMAIL: 'email',
  CHAT: 'web_chat',
}

export interface TrengoWorkspaceChannel {
  id: number
  name: string
  kind: TrengoChannel | null
}

export async function listTrengoChannels(
  agentId: string,
  requestId: string,
): Promise<
  | { available: true; channels: TrengoWorkspaceChannel[] }
  | { available: false; reason: string }
> {
  try {
    const client = await createClientForAgent({
      agentId,
      requestId,
      purpose: 'trengo.list_channels',
    })
    const rows = await client.listChannels()
    return {
      available: true,
      channels: rows
        .filter((r) => typeof r.id === 'number')
        .map((r) => ({
          id: r.id,
          name: r.name?.trim() || `Channel ${r.id}`,
          kind: CHANNEL_KIND_BY_TYPE[(r.type ?? '').toUpperCase()] ?? null,
        })),
    }
  } catch (err) {
    if (err instanceof BusinessError && err.code === 'TOKEN_EXPIRED') {
      return {
        available: false,
        reason: 'Connect your Trengo token (Account → Trengo) to pick a send channel.',
      }
    }
    return { available: false, reason: 'Could not load channels from Trengo.' }
  }
}
