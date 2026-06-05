// Side-effecting Google Voice handler (Option A — ADR 0032). Called from the
// Gmail sync `processMessage` when a message is a Google Voice notification and
// the `google_voice.email_ingest_enabled` flag is on.
//
// Google Voice gives us no call API, so these emails ARE the signal. We:
//   1. parse the email (pure, ./google-voice),
//   2. resolve-or-create the Contact by the counterparty number (the same
//      resolver Aircall uses — a call is a real human touch, §16),
//   3. stream any voicemail audio to S3,
//   4. write a `call`/`message` Interaction flagged `needsManualReview` for the
//      voicemail + missed-call cases (an agent types up the summary / checks
//      the missed call — this channel needs manual work by design), and
//   5. post a best-effort Slack alert so the team knows to action it.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { resolveOrCreateContactForCall } from '@studymind/core/contact/from-call'
import { db } from '@studymind/db'

import type { GmailClient, GmailMessage } from './client'
import {
  parseGoogleVoiceNotification,
  type GoogleVoiceKind,
  type GoogleVoiceNotification,
} from './google-voice'
import { putAttachment } from './s3'

interface HandleInput {
  message: GmailMessage
  agentId: string
  requestId: string
  subject: string
  client: GmailClient
}

/** Interaction enum value per Google Voice notification kind. */
function interactionTypeFor(kind: GoogleVoiceKind): 'call' | 'message' | null {
  if (kind === 'voicemail' || kind === 'missed_call') return 'call'
  if (kind === 'text') return 'message'
  return null
}

function counterpartyLabel(n: GoogleVoiceNotification): string {
  return n.counterpartyName ?? n.phoneRaw ?? 'an unknown number'
}

function summaryFor(n: GoogleVoiceNotification): string {
  const who = counterpartyLabel(n)
  switch (n.kind) {
    case 'voicemail':
      return `Google Voice voicemail from ${who} — type up the summary`
    case 'missed_call':
      return `Google Voice missed call from ${who} — check & follow up`
    case 'text':
      return `Google Voice text from ${who}`
    default:
      return `Google Voice message from ${who}`
  }
}

const APP_URL = (process.env['NEXT_PUBLIC_APP_URL'] ?? process.env['APP_URL'] ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
)

/**
 * Handle a Google Voice notification email. Returns `true` when it took
 * ownership of the message (so the caller skips the normal email path), and
 * `false` for emails we don't recognise (account notices etc.) so they fall
 * through to ordinary email handling.
 */
export async function handleGoogleVoiceMessage(input: HandleInput): Promise<boolean> {
  const parsed = parseGoogleVoiceNotification({ subject: input.subject, bodyText: input.message.body })
  const interactionType = interactionTypeFor(parsed.kind)
  if (!interactionType) return false // unknown — let the normal path log it

  // Resolve (or create) the contact from the counterparty number. When we
  // couldn't normalise the number to E.164 the resolver no-ops and the call is
  // logged unmatched + flagged for a human.
  let contactId: string | null = null
  let familyId: string | null = null
  if (parsed.phoneE164) {
    const [first, ...rest] = (parsed.counterpartyName ?? '').trim().split(/\s+/)
    const resolved = await resolveOrCreateContactForCall(
      db,
      {
        phoneE164: parsed.phoneE164,
        firstName: first || null,
        lastName: rest.length > 0 ? rest.join(' ') : null,
      },
      { referralSource: 'Google Voice', actorId: null, requestId: input.requestId },
    )
    contactId = resolved.contactId
    familyId = resolved.familyId
  }

  // Stream any attachments (voicemail audio) to S3.
  const attachmentRefs: Array<{ s3Key: string; filename: string; mimeType: string; sizeBytes: number }> = []
  for (const att of input.message.attachments) {
    const body = await input.client.getAttachment(input.message.id, att.attachmentId)
    const { s3Key } = await putAttachment({
      messageId: input.message.id,
      attachmentId: att.attachmentId,
      filename: att.filename,
      body,
      contentType: att.mimeType,
    })
    attachmentRefs.push({ s3Key, filename: att.filename, mimeType: att.mimeType, sizeBytes: att.sizeBytes })
  }

  // Voicemail + missed call need a human to type up the summary / check the
  // call; an inbound text already carries its content.
  const needsManualReview = parsed.kind === 'voicemail' || parsed.kind === 'missed_call'
  const summary = summaryFor(parsed)

  const interaction = await db.interaction.create({
    data: {
      id: createId(),
      type: interactionType,
      contactId,
      familyId,
      occurredAt: new Date(input.message.internalDate || Date.now()),
      summary: summary.slice(0, 280),
      payload: {
        event: 'google_voice.message_ingested',
        source: 'google_voice',
        googleVoiceType: parsed.kind,
        counterpartyName: parsed.counterpartyName,
        phoneRaw: parsed.phoneRaw,
        phoneE164: parsed.phoneE164,
        transcript: parsed.content,
        needsManualReview,
        triageRequired: parsed.phoneE164 == null,
        gmailMessageId: input.message.id,
        gmailThreadId: input.message.threadId,
        attachments: attachmentRefs,
      },
    },
    select: { id: true },
  })

  await writeAuditLogEntry(db, {
    actorId: null,
    requestId: input.requestId,
    action: 'google_voice.message_ingested',
    target: contactId
      ? { type: 'Contact', id: contactId }
      : { type: 'Interaction', id: interaction.id },
    after: {
      interactionId: interaction.id,
      googleVoiceType: parsed.kind,
      phoneE164: parsed.phoneE164,
      needsManualReview,
      gmailMessageId: input.message.id,
    },
  })

  await postManualReviewAlert({
    parsed,
    contactId,
    requestId: input.requestId,
    summary,
    messageId: input.message.id,
  })

  return true
}

/**
 * Best-effort Slack alert so the team knows a Google Voice item needs manual
 * work. Never throws — a missing Slack config must not fail the Gmail sync.
 */
async function postManualReviewAlert(args: {
  parsed: GoogleVoiceNotification
  contactId: string | null
  requestId: string
  summary: string
  messageId: string
}): Promise<void> {
  try {
    // Route the alert via the operator-configured topic mapping (Settings →
    // Slack channels → "Where notifications go"); falls back to the default
    // channel → env. Null = muted/unconfigured → skip silently.
    const { resolveTopicChannelId } = await import('@studymind/core/slack')
    const channelId = await resolveTopicChannelId(db, 'google_voice')
    if (!channelId) return

    const link = args.contactId ? `${APP_URL}/contacts/${args.contactId}` : null
    const lines = [
      `:telephone_receiver: *${args.summary}*`,
      args.parsed.phoneRaw ? `Number: ${args.parsed.phoneRaw}` : null,
      args.parsed.content ? `Transcript: ${args.parsed.content.slice(0, 500)}` : null,
      link ? `Contact: ${link}` : 'No contact matched — please check Google Voice and assign.',
    ].filter(Boolean)

    const { postAlert } = await import('@studymind/integration-slack/outbound')
    await postAlert({
      message: lines.join('\n'),
      idempotencyKey: `google-voice:${args.messageId}`,
      channelId,
      ctx: { actorId: 'system:google-voice', requestId: args.requestId },
    })
  } catch {
    // Best-effort: swallow so Gmail sync continues even if Slack is down.
  }
}
