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

export type ChannelKey = 'slack' | 'trengo' | 'whatsapp' | 'sms' | 'email'

export type SendResults = Partial<Record<ChannelKey, ChannelResult>>

/**
 * Channel senders injected by the caller. Each returns a ChannelResult and is
 * expected NOT to throw for an expected condition (token expiry, missing
 * conversation) — it returns `failed`/`skipped` instead. The orchestrator
 * still guards every call with try/catch so an unexpected throw degrades to a
 * `failed` result rather than aborting the whole fan-out.
 */
/** Resolved attachment bytes ready to hand to the integration sender.
 * The tRPC layer turns attachment ids into these. */
export interface ResolvedAttachment {
  filename: string
  contentType: string
  data: Buffer
}

/** An approved Trengo WhatsApp (HSM) template the agent picked for the
 *  WhatsApp channel. When present the sender uses the template session send
 *  (valid outside the 24-hour window) instead of a free-text message. No
 *  attachments ride this path — the approved templates already carry the
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
  }) => Promise<ChannelResult>
  trengo?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    /** Trengo sender line (channel id) to start a NEW conversation from. */
    trengoChannelId?: number
  }) => Promise<ChannelResult>
  /** Explicit WhatsApp send via Trengo (continues the WhatsApp thread if one
   *  exists, else starts one). Distinct from `trengo` which uses whatever the
   *  contact's most-recent conversation channel happens to be. */
  whatsapp?: (args: {
    body: string
    contactId: string
    attachments?: ReadonlyArray<ResolvedAttachment>
    trengoTemplate?: WhatsAppTemplateRef
    trengoChannelId?: number
  }) => Promise<ChannelResult>
  /** Explicit SMS send via Trengo (continues the SMS thread if one exists,
   *  else starts one to the contact's E.164 number). */
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
    channels: { slack?: boolean; trengo?: boolean; whatsapp?: boolean; sms?: boolean; email?: boolean }
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
        event: 'card.call_summary_sent',
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
