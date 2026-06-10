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
  trengoMessageId: number
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
    // Upload any attachments first, collecting Trengo media ids + the
    // metadata we surface in the timeline.
    const attachmentIds: number[] = []
    const attachmentMeta: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      trengoMediaId: number
    }> = []
    for (const att of input.attachments ?? []) {
      const media = await client.uploadMedia({
        filename: att.filename,
        contentType: att.contentType,
        data: att.data,
      })
      attachmentIds.push(media.id)
      attachmentMeta.push({
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.data.byteLength,
        trengoMediaId: media.id,
      })
    }

    const message = await client.sendMessage({
      ticketId: input.ticketId,
      body: input.body,
      channel: input.channel,
      customFields: {
        // Per CLAUDE.md §11 — embed our Interaction id and agent id so
        // inbound webhook events for this message reconcile cleanly.
        interactionId,
        agentId: input.agentId,
      },
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })

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
          trengoMessageId: message.id,
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
        trengoMessageId: message.id,
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
    })

    return { interactionId, trengoMessageId: message.id }
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
    // Upload any attachments first, collecting Trengo media ids + metadata for
    // the timeline (mirrors sendMessage).
    const attachmentIds: number[] = []
    const attachmentMeta: Array<{
      filename: string
      contentType: string
      sizeBytes: number
      trengoMediaId: number
    }> = []
    for (const att of input.attachments ?? []) {
      const media = await client.uploadMedia({
        filename: att.filename,
        contentType: att.contentType,
        data: att.data,
      })
      attachmentIds.push(media.id)
      attachmentMeta.push({
        filename: att.filename,
        contentType: att.contentType,
        sizeBytes: att.data.byteLength,
        trengoMediaId: media.id,
      })
    }

    const result = await client.createConversation({
      channel: input.channel,
      recipient: input.recipient,
      body: input.body,
      customFields: { interactionId, agentId: input.agentId },
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    })
    if (!result.ticketId) {
      throw new TrengoApiError(502, '/messages', { reason: 'no ticket id returned' })
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
  /** Target CRM User.id whose Trengo identity we'll resolve. */
  assigneeUserId: string
  requestId: string
}

export interface AssignConversationResult {
  interactionId: string
  ticketId: number
  assigneeUserId: string
  trengoAssigneeId: number
}

export async function assignConversation(
  input: AssignConversationInput,
): Promise<AssignConversationResult> {
  // 1. Resolve the target user's Trengo identity. No Trengo id → no point
  //    issuing the PATCH (Trengo would reject).
  const target = await db.user.findUnique({
    where: { id: input.assigneeUserId },
    select: { id: true, trengoUserId: true },
  })
  if (!target) {
    throw new BusinessError('UNKNOWN_USER', 'Assignee user not found', {
      assigneeUserId: input.assigneeUserId,
    })
  }
  if (target.trengoUserId === null) {
    throw new BusinessError(
      'NO_TRENGO_IDENTITY',
      'Target user has no Trengo identity — they need to connect their Trengo token.',
      { assigneeUserId: input.assigneeUserId },
    )
  }
  const trengoAssigneeId = target.trengoUserId

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
          assigneeUserId: input.assigneeUserId,
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
          assigneeUserId: input.assigneeUserId,
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
        assigneeUserId: input.assigneeUserId,
        trengoAssigneeId,
      },
    })

    await applyEventToConversation(db, {
      ticketId: input.ticketId,
      eventName: 'ticket.assigned',
      occurredAt: new Date(),
      contactId: input.contactId,
      assigneeUserId: input.assigneeUserId,
      trengoAssigneeId,
    })

    return {
      interactionId,
      ticketId: input.ticketId,
      assigneeUserId: input.assigneeUserId,
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
    select: { payload: true },
  })
  const existingPayload = (row?.payload as Record<string, unknown> | null) ?? {}

  await db.interaction.update({
    where: { id: interactionId },
    data: {
      payload: {
        ...existingPayload,
        status: 'pending_send',
        lastError: reason,
        lastErrorAt: new Date().toISOString(),
      },
    },
  })
}
