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

export type ChannelKey = 'slack' | 'trengo' | 'whatsapp' | 'sms' | 'email'
export type SendResults = Partial<Record<ChannelKey, ChannelResult>>

/** An approved Trengo WhatsApp (HSM) template the agent picked for the
 *  WhatsApp channel. When present the sender uses the template session
 *  send (valid outside the 24-hour window) instead of a free-text message.
 *  No attachments ride this path — the approved templates already carry the
 *  info-pack links. */
export interface WhatsAppTemplateRef {
  templateId: number
  templateTitle: string
  params: Array<{ key: string; value: string }>
}

export interface CallSummarySenders {
  slack?: (args: {
    body: string
    contactName: string
    contactId: string
    slackChannelId?: string
    /** Call outcome + layout hint — the internal-note variant renders the
     *  VA-team format (outcome — name — phone — email + pending tasks). */
    outcome?: 'answered' | 'voicemail' | 'no_answer' | null
    variant?: 'summary' | 'internal_note'
    /** ADR 0039 amendment: the rich, status-led `#callsummaries` layout. */
    disposition?: 'sent_to_customer' | 'va_handoff' | 'logged'
    /** Channels the customer summary was actually sent on (sent_to_customer). */
    sentChannels?: ReadonlyArray<string>
    /** Follow-up tasks raised alongside the summary. */
    followUps?: ReadonlyArray<{
      title: string
      dueAt?: Date | string | null
      assignee?: string | null
    }>
    /** Who a va_handoff is assigned to (person or team name). */
    handoffAssignee?: string | null
    /** Staff member who logged the summary (rendered as a footer). */
    authorName?: string | null
  }) => Promise<ChannelResult>
  trengo?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    /** Trengo sender line (channel id) to start a NEW conversation from. */
    trengoChannelId?: number
  }) => Promise<ChannelResult>
  whatsapp?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    trengoTemplate?: WhatsAppTemplateRef
    trengoChannelId?: number
  }) => Promise<ChannelResult>
  sms?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    trengoChannelId?: number
  }) => Promise<ChannelResult>
  email?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    /** Subject for a fresh email when the contact has no Gmail thread yet. */
    subject?: string
    /** Full-Gmail extras: recipient override + Cc/Bcc + send-from address. */
    to?: ReadonlyArray<string>
    cc?: ReadonlyArray<string>
    bcc?: ReadonlyArray<string>
    fromAddress?: string
  }) => Promise<ChannelResult>
}

/** Resolved attachment bytes ready to hand to the integration sender. */
export interface ResolvedAttachment {
  filename: string
  contentType: string
  data: Buffer
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

/**
 * Log the INTERNAL call note (step 2 of the two-step flow): what happened plus
 * next steps / instructions for the VA team. Persists as a staff-only `note`
 * Interaction on the contact (never sent to the customer) and audits. The
 * optional Slack post + follow-up task are wired by the tRPC layer.
 */
export async function addContactInternalNote(
  db: Db,
  input: { contactId: string; note: string },
  ctx: ActorCtx,
): Promise<{ id: string }> {
  const note = input.note.trim()
  if (note.length === 0) {
    throw new BusinessError('CALL_SUMMARY_EMPTY', 'An internal note cannot be empty')
  }
  const contact = await db.contact.findFirst({
    where: { id: input.contactId, deletedAt: null },
    select: { id: true },
  })
  if (!contact) throw new BusinessError('CONTACT_NOT_FOUND', 'Contact not found')

  const id = createId()
  await db.interaction.create({
    data: {
      id,
      type: 'note',
      contactId: contact.id,
      occurredAt: new Date(),
      summary: note.length > 120 ? `${note.slice(0, 117)}…` : note,
      payload: {
        event: 'contact.call_summary_internal_note',
        internal: true,
        kind: 'call_followup',
        body: note,
        authorId: ctx.actorId,
      } satisfies Prisma.InputJsonObject,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'contact.call_summary_internal_note',
    target: { type: 'Contact', id: contact.id },
    before: null,
    after: { interactionId: id, internal: true },
  })

  return { id }
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
  for (const k of ['slack', 'trengo', 'whatsapp', 'sms', 'email'] as ChannelKey[]) {
    const v = r[k]
    if (!v) continue
    parts.push(`${k}: ${v.status}`)
  }
  return parts.join(', ') || 'no channels'
}

function toJsonResults(r: SendResults): Prisma.InputJsonObject {
  const out: Record<string, unknown> = {}
  for (const k of ['slack', 'trengo', 'whatsapp', 'sms', 'email'] as ChannelKey[]) {
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
    channels: {
      slack?: boolean
      trengo?: boolean
      whatsapp?: boolean
      sms?: boolean
      email?: boolean
    }
    slackChannelId?: string
    /** Optional pre-resolved attachments, delivered with every customer
     *  channel that supports them (WhatsApp / SMS / Trengo / email). The
     *  WhatsApp template path ignores them by design. */
    attachments?: ReadonlyArray<ResolvedAttachment>
    /** Per-channel body overrides (the wizard composes the email and the
     *  text separately). A channel without an override sends the summary
     *  Interaction's body. */
    channelBodies?: { whatsapp?: string; sms?: string; email?: string; trengo?: string }
    /** Subject for a fresh email when the contact has no Gmail thread yet. */
    emailSubject?: string
    /** Full-Gmail extras for the email channel. */
    emailTo?: ReadonlyArray<string>
    emailCc?: ReadonlyArray<string>
    emailBcc?: ReadonlyArray<string>
    emailFromAddress?: string
    /** Trengo sender line (channel id) for a NEW WhatsApp/SMS conversation. */
    trengoChannelId?: number
    /** Approved Trengo WhatsApp template — sent via the template session
     *  instead of free text when present. */
    whatsappTemplate?: WhatsAppTemplateRef
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
  const bodyFor = (channel: 'whatsapp' | 'sms' | 'email' | 'trengo'): string => {
    const override = input.channelBodies?.[channel]
    return typeof override === 'string' && override.trim().length > 0 ? override : body
  }
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
      input.senders.trengo
        ? () =>
            input.senders.trengo!({
              body: bodyFor('trengo'),
              contactId,
              attachments: input.attachments,
              ...(input.trengoChannelId ? { trengoChannelId: input.trengoChannelId } : {}),
            })
        : undefined,
    )
  }
  if (input.channels.whatsapp) {
    results.whatsapp = await runChannel(
      input.senders.whatsapp
        ? () =>
            input.senders.whatsapp!({
              body: bodyFor('whatsapp'),
              contactId,
              // The template path carries the pack links itself — never
              // double-attach (the user's templates already include them).
              ...(input.whatsappTemplate
                ? { trengoTemplate: input.whatsappTemplate }
                : { attachments: input.attachments }),
              ...(input.trengoChannelId ? { trengoChannelId: input.trengoChannelId } : {}),
            })
        : undefined,
    )
  }
  if (input.channels.sms) {
    results.sms = await runChannel(
      input.senders.sms
        ? () =>
            input.senders.sms!({
              body: bodyFor('sms'),
              contactId,
              attachments: input.attachments,
              ...(input.trengoChannelId ? { trengoChannelId: input.trengoChannelId } : {}),
            })
        : undefined,
    )
  }
  if (input.channels.email) {
    results.email = await runChannel(
      input.senders.email
        ? () =>
            input.senders.email!({
              body: bodyFor('email'),
              contactId,
              attachments: input.attachments,
              ...(input.emailSubject ? { subject: input.emailSubject } : {}),
              ...(input.emailTo && input.emailTo.length > 0 ? { to: input.emailTo } : {}),
              ...(input.emailCc && input.emailCc.length > 0 ? { cc: input.emailCc } : {}),
              ...(input.emailBcc && input.emailBcc.length > 0 ? { bcc: input.emailBcc } : {}),
              ...(input.emailFromAddress ? { fromAddress: input.emailFromAddress } : {}),
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
          whatsapp: Boolean(input.channels.whatsapp),
          sms: Boolean(input.channels.sms),
          email: Boolean(input.channels.email),
        },
        ...(input.channelBodies
          ? {
              channelBodies: Object.fromEntries(
                Object.entries(input.channelBodies).filter(
                  ([, v]) => typeof v === 'string' && v.length > 0,
                ),
              ),
            }
          : {}),
        ...(input.whatsappTemplate
          ? {
              whatsappTemplate: {
                id: input.whatsappTemplate.templateId,
                title: input.whatsappTemplate.templateTitle,
              },
            }
          : {}),
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
