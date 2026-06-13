// Real channel senders for `sendCallSummary` (slice B). The domain
// orchestrator (packages/core) is pure and cannot import integration clients,
// so the tRPC layer supplies these. Each sender resolves what it needs from
// the DB and calls the existing audited outbound function, returning a
// ChannelResult. Senders never throw for an expected condition (no
// conversation, token expiry, no Gmail) — they return `skipped`/`failed` so
// the orchestrator records a per-channel outcome and keeps going.

import type { CallSummarySenders, ChannelResult } from '@studymind/core/board'
import { BusinessError } from '@studymind/core/errors'
import {
  buildCallSummarySlackBlocks,
  buildCallSummarySlackText,
  parseActionButtons,
} from '@studymind/core/slack'
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

/**
 * Build the live senders. Returns a partial map: a channel is only included
 * when it is wired (always, for the three we support). Availability checks
 * (phone, email, Gmail connection) happen inside each sender so the result is
 * `skipped` with a reason rather than silently dropped.
 */
export function buildCallSummarySenders({ agentId, requestId }: BuildArgs): CallSummarySenders {
  // Explicit WhatsApp / SMS send via Trengo: continue the contact's existing
  // thread on that channel if one exists, else start a new one to their E.164
  // number. Fail-soft (skipped/failed) like every other sender.
  async function sendViaTrengoChannel(
    channel: 'whatsapp' | 'sms',
    contactId: string,
    body: string,
    attachments?: ReadonlyArray<{ filename: string; contentType: string; data: Buffer }>,
    trengoChannelId?: number,
  ): Promise<ChannelResult> {
    const { resolveActiveTrengoConversation } = await import(
      '@studymind/integration-trengo/conversations'
    )
    const { sendMessage, startConversation } = await import(
      '@studymind/integration-trengo/outbound'
    )
    // Trengo media is uploaded then attached by id (sendMessage/startConversation
    // do the upload). A readonly array can't be passed straight through.
    const atts = attachments && attachments.length > 0 ? [...attachments] : undefined
    try {
      const conv = await resolveActiveTrengoConversation(db, contactId, channel)
      if (conv) {
        const r = await sendMessage({
          contactId,
          agentId,
          ticketId: conv.ticketId,
          channel,
          body,
          requestId,
          attachments: atts,
        })
        return { status: 'sent', ref: String(r.trengoMessageId) }
      }
      const contact = await db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { phoneE164: true },
      })
      const phone = contact?.phoneE164?.trim()
      if (!phone || !phone.startsWith('+')) {
        return { status: 'skipped', detail: 'Contact has no E.164 phone number' }
      }
      const r = await startConversation({
        contactId,
        agentId,
        channel,
        recipient: phone,
        body,
        requestId,
        attachments: atts,
        // The agent's chosen sender line (workspaces run several WA/SMS lines).
        ...(trengoChannelId ? { trengoChannelId } : {}),
      })
      return {
        status: 'sent',
        ref: r.trengoMessageId != null ? String(r.trengoMessageId) : String(r.ticketId),
      }
    } catch (err) {
      if (err instanceof BusinessError) {
        return { status: 'failed', detail: `${err.code}: ${err.message}` }
      }
      return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    async slack({
      body,
      contactName,
      contactId,
      slackChannelId,
      outcome,
      variant,
    }): Promise<ChannelResult> {
      // Resolve the target channel + its deep-link action buttons. Order:
      // (1) the channel the agent picked (slackChannelId), (2) the configured
      // default SlackChannelOption, (3) the legacy env channel as a fallback so
      // deploys without any configured options keep working (CLAUDE.md §12).
      const option = slackChannelId
        ? await db.slackChannelOption.findFirst({
            where: { channelId: slackChannelId, archivedAt: null },
            select: { channelId: true, actionButtons: true },
          })
        : await db.slackChannelOption.findFirst({
            where: { isDefault: true, archivedAt: null },
            select: { channelId: true, actionButtons: true },
          })

      const channelId =
        option?.channelId ?? slackChannelId ?? process.env['SLACK_ALERTS_CHANNEL_ID']
      if (!channelId) {
        return { status: 'skipped', detail: 'No Slack channel configured' }
      }

      const contactUrl = `${appUrl()}/contacts/${contactId}`
      const buttons = parseActionButtons(option?.actionButtons)
      // Phone + email ride the headline so the VA team can act without
      // opening the CRM (the internal-note layout).
      const contactRow = await db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { phoneE164: true, email: true },
      })
      const enriched = {
        contactName,
        body,
        contactUrl,
        buttons,
        contactPhone: contactRow?.phoneE164 ?? null,
        contactEmail: contactRow?.email ?? null,
        outcome: outcome ?? null,
        variant: variant ?? ('summary' as const),
      }
      const blocks = buildCallSummarySlackBlocks(enriched)

      const { postAlert } = await import('@studymind/integration-slack/outbound')
      const result = await postAlert({
        message: buildCallSummarySlackText(enriched),
        blocks,
        idempotencyKey: `call-summary:${contactId}:${requestId}`,
        channelId,
        ctx: { actorId: agentId, requestId },
      })
      return { status: 'sent', ref: result.slackTs }
    },

    async trengo({ body, contactId, attachments }): Promise<ChannelResult> {
      // Resolve the contact's most recent Trengo conversation (ticket +
      // channel). Shared with the inbox / contact reply path so the lookup
      // lives in one place (packages/integrations/trengo/src/conversations.ts).
      const { resolveActiveTrengoConversation } = await import(
        '@studymind/integration-trengo/conversations'
      )
      const conv = await resolveActiveTrengoConversation(db, contactId)
      if (!conv) {
        return { status: 'skipped', detail: 'No Trengo conversation for this contact' }
      }

      const { sendMessage } = await import('@studymind/integration-trengo/outbound')
      try {
        const result = await sendMessage({
          contactId,
          agentId,
          ticketId: conv.ticketId,
          channel: conv.channel,
          body,
          requestId,
          attachments:
            attachments && attachments.length > 0 ? [...attachments] : undefined,
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

    async whatsapp({ body, contactId, attachments, trengoTemplate, trengoChannelId }): Promise<ChannelResult> {
      // An approved Trengo WhatsApp template goes out via the template
      // session (/wa_sessions) — the same thing the Trengo composer does, so
      // it works outside the 24-hour window. Free text keeps the thread path.
      if (trengoTemplate) {
        try {
          const contact = await db.contact.findFirst({
            where: { id: contactId, deletedAt: null },
            select: { phoneE164: true },
          })
          const phone = contact?.phoneE164?.trim()
          if (!phone || !phone.startsWith('+')) {
            return { status: 'skipped', detail: 'Contact has no E.164 phone number' }
          }
          const { sendWhatsAppTemplate } = await import(
            '@studymind/integration-trengo/outbound'
          )
          const r = await sendWhatsAppTemplate({
            contactId,
            agentId,
            recipient: phone,
            templateId: trengoTemplate.templateId,
            templateTitle: trengoTemplate.templateTitle,
            renderedBody: body,
            params: trengoTemplate.params,
            requestId,
          })
          return {
            status: 'sent',
            ref:
              r.trengoMessageId != null
                ? String(r.trengoMessageId)
                : r.ticketId != null
                  ? String(r.ticketId)
                  : r.interactionId,
          }
        } catch (err) {
          if (err instanceof BusinessError) {
            return { status: 'failed', detail: `${err.code}: ${err.message}` }
          }
          return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
        }
      }
      return sendViaTrengoChannel('whatsapp', contactId, body, attachments, trengoChannelId)
    },

    async sms({ body, contactId, attachments, trengoChannelId }): Promise<ChannelResult> {
      return sendViaTrengoChannel('sms', contactId, body, attachments, trengoChannelId)
    },

    async email({
      body,
      contactId,
      attachments,
      subject: subjectOverride,
      to,
      cc,
      bcc,
      fromAddress,
    }): Promise<ChannelResult> {
      const contact = await db.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { email: true },
      })
      // Recipient: the agent's explicit To override wins; else the contact's
      // stored address (full-Gmail compose lets you mail someone before their
      // email is on file).
      const toAddresses =
        to && to.length > 0 ? [...to] : contact?.email ? [contact.email] : []
      if (toAddresses.length === 0) {
        return { status: 'skipped', detail: 'No recipient email address' }
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
      const ccList = cc && cc.length > 0 ? [...cc] : undefined
      const bccList = bcc && bcc.length > 0 ? [...bcc] : undefined
      const mappedAttachments =
        attachments && attachments.length > 0
          ? attachments.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              data: a.data,
            }))
          : undefined

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

      // An explicit To override or a fresh subject means the agent is
      // composing a NEW email (full-Gmail compose), so don't bury it inside an
      // old reply thread — start fresh. Otherwise reply on the latest thread.
      const forceNew = (to && to.length > 0) || Boolean(fromAddress)

      try {
        if (!threadId || forceNew) {
          // No prior thread — start a fresh one rather than skipping, so the
          // wizard's email step works for brand-new enquiries too.
          const { sendEmail } = await import('@studymind/integration-gmail/outbound')
          const result = await sendEmail({
            agentId,
            subject: subjectOverride?.trim() || 'Following up on our call',
            body,
            toAddresses,
            cc: ccList,
            bcc: bccList,
            ...(fromAddress ? { fromAddress } : {}),
            requestId,
            attachments: mappedAttachments,
          })
          return { status: 'sent', ref: result.gmailMessageId }
        }

        const subject =
          subjectOverride?.trim() ||
          (typeof payload['subject'] === 'string'
            ? (payload['subject'] as string)
            : recent?.summary ?? 'Call summary')
        const originalMessageId =
          typeof payload['messageId'] === 'string' ? (payload['messageId'] as string) : undefined

        const { sendReply } = await import('@studymind/integration-gmail/outbound')
        const result = await sendReply({
          agentId,
          threadId,
          subject,
          body,
          toAddresses,
          cc: ccList,
          bcc: bccList,
          requestId,
          originalMessageId,
          attachments: mappedAttachments,
        })
        return { status: 'sent', ref: result.gmailMessageId }
      } catch (err) {
        return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
      }
    },
  }
}
