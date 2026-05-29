// Real channel senders for `sendCallSummary` (slice B). The domain
// orchestrator (packages/core) is pure and cannot import integration clients,
// so the tRPC layer supplies these. Each sender resolves what it needs from
// the DB and calls the existing audited outbound function, returning a
// ChannelResult. Senders never throw for an expected condition (no
// conversation, token expiry, no Gmail) — they return `skipped`/`failed` so
// the orchestrator records a per-channel outcome and keeps going.

import type { CallSummarySenders, ChannelResult } from '@studymind/core/board'
import { BusinessError } from '@studymind/core/errors'
import { db } from '@/lib/db'

interface BuildArgs {
  agentId: string
  requestId: string
}

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

/** Compose the message text shared across channels. */
function composeText(body: string, contactName: string, contactId: string): string {
  const link = `${appUrl()}/contacts/${contactId}`
  return `Call summary for ${contactName}\n\n${body}\n\n${link}`
}

/**
 * Build the live senders. Returns a partial map: a channel is only included
 * when it is wired (always, for the three we support). Availability checks
 * (phone, email, Gmail connection) happen inside each sender so the result is
 * `skipped` with a reason rather than silently dropped.
 */
export function buildCallSummarySenders({ agentId, requestId }: BuildArgs): CallSummarySenders {
  return {
    async slack({ body, contactName, contactId, slackChannelId }): Promise<ChannelResult> {
      const channelId = slackChannelId ?? process.env['SLACK_ALERTS_CHANNEL_ID']
      if (!channelId) {
        return { status: 'skipped', detail: 'No Slack channel configured' }
      }
      const { postAlert } = await import('@studymind/integration-slack/outbound')
      const result = await postAlert({
        message: composeText(body, contactName, contactId),
        idempotencyKey: `call-summary:${contactId}:${requestId}`,
        channelId,
        ctx: { actorId: agentId, requestId },
      })
      return { status: 'sent', ref: result.slackTs }
    },

    async trengo({ body, contactId }): Promise<ChannelResult> {
      // Resolve the most recent Trengo conversation for this contact: the
      // latest message Interaction carrying a ticketId + channel.
      const contact = await db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { phoneE164: true },
      })
      if (!contact?.phoneE164) {
        return { status: 'skipped', detail: 'Contact has no phone number' }
      }
      const recent = await db.interaction.findFirst({
        where: { contactId, type: 'message', deletedAt: null },
        orderBy: { occurredAt: 'desc' },
        select: { payload: true },
      })
      const payload = (recent?.payload ?? {}) as Record<string, unknown>
      const ticketId = typeof payload['ticketId'] === 'number' ? payload['ticketId'] : null
      const channel = typeof payload['channel'] === 'string' ? payload['channel'] : null
      if (!ticketId || !channel) {
        return { status: 'skipped', detail: 'No Trengo conversation for this contact' }
      }

      const { sendMessage } = await import('@studymind/integration-trengo/outbound')
      const { isTrengoChannel } = await import('@studymind/integration-trengo/types')
      if (!isTrengoChannel(channel)) {
        return { status: 'skipped', detail: 'Unknown Trengo channel' }
      }
      try {
        const result = await sendMessage({
          contactId,
          agentId,
          ticketId,
          channel,
          body,
          requestId,
        })
        return { status: 'sent', ref: String(result.trengoMessageId) }
      } catch (err) {
        // TOKEN_EXPIRED (and any other) fail closed for this channel only.
        if (err instanceof BusinessError) {
          return { status: 'failed', detail: `${err.code}: ${err.message}` }
        }
        return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
      }
    },

    async email({ body, contactId }): Promise<ChannelResult> {
      const contact = await db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { email: true },
      })
      if (!contact?.email) {
        return { status: 'skipped', detail: 'Contact has no email address' }
      }
      // The acting agent must have a connected Gmail mailbox.
      const mailbox = await db.gmailMailbox.findFirst({
        where: { agentId, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        select: { address: true },
      })
      if (!mailbox) {
        return { status: 'skipped', detail: 'Agent has no Gmail connected' }
      }
      // Reply on the most recent email thread we have for the contact.
      const recent = await db.interaction.findFirst({
        where: {
          contactId,
          type: { in: ['email_received', 'email_sent'] },
          deletedAt: null,
        },
        orderBy: { occurredAt: 'desc' },
        select: { payload: true, summary: true },
      })
      const payload = (recent?.payload ?? {}) as Record<string, unknown>
      const threadId =
        typeof payload['threadId'] === 'string'
          ? payload['threadId']
          : typeof payload['gmailThreadId'] === 'string'
            ? (payload['gmailThreadId'] as string)
            : null
      if (!threadId) {
        return { status: 'skipped', detail: 'No Gmail thread for this contact' }
      }
      const subject =
        typeof payload['subject'] === 'string'
          ? (payload['subject'] as string)
          : recent?.summary ?? 'Call summary'
      const originalMessageId =
        typeof payload['messageId'] === 'string' ? (payload['messageId'] as string) : undefined

      try {
        const { sendReply } = await import('@studymind/integration-gmail/outbound')
        const result = await sendReply({
          agentId,
          threadId,
          subject,
          body,
          toAddresses: [contact.email],
          requestId,
          originalMessageId,
        })
        return { status: 'sent', ref: result.gmailMessageId }
      } catch (err) {
        return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
