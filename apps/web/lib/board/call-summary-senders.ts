// Slack sender for the call-summary announce (redesign 2026-07). The domain
// orchestrators (packages/core) are pure and cannot import integration
// clients, so the tRPC layer supplies this. A call summary is recorded on the
// CRM and announced to the operator-configured `#callsummaries` channel — no
// customer message is ever sent. The sender never throws for an expected
// condition (no Slack channel configured) — it returns `skipped`/`failed` so a
// Slack failure never loses the CRM record.

import type { CallOutcome, CallSummarySenders, ChannelResult } from '@studymind/core/board'
import {
  buildCallSummarySlackBlocks,
  buildCallSummarySlackText,
  parseActionButtons,
  resolveTopicChannelId,
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
 * Build the live Slack sender. Availability (a configured channel) is checked
 * inside the sender so the result is `skipped` with a reason rather than
 * silently dropped.
 */
export function buildCallSummarySenders({ agentId, requestId }: BuildArgs): CallSummarySenders {
  return {
    async slack({ body, contactName, contactId, slackChannelId, outcome, authorName }): Promise<ChannelResult> {
      // Resolve the target channel + its deep-link action buttons. An explicit
      // per-send pick wins; otherwise call summaries route to the operator-
      // configured `#callsummaries` channel via the ADR 0033 topic router
      // (route → default option → SLACK_ALERTS_CHANNEL_ID), so the destination
      // is controlled from Settings → Slack channels and never hardcoded.
      let channelId: string | null
      let option: { actionButtons: unknown } | null
      if (slackChannelId) {
        option = await db.slackChannelOption.findFirst({
          where: { channelId: slackChannelId, archivedAt: null },
          select: { actionButtons: true },
        })
        channelId = slackChannelId
      } else {
        channelId = await resolveTopicChannelId(db, 'call_summary')
        option = channelId
          ? await db.slackChannelOption.findFirst({
              where: { channelId, archivedAt: null },
              select: { actionButtons: true },
            })
          : null
      }

      if (!channelId) {
        return {
          status: 'skipped',
          detail: 'No Slack channel configured for call summaries (Settings → Slack channels)',
        }
      }

      const contactUrl = `${appUrl()}/contacts/${contactId}`
      const buttons = parseActionButtons(option?.actionButtons)
      // Phone + email ride the headline so the team can act without opening the
      // CRM.
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
        ...(authorName ? { authorName } : {}),
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
  }
}

/**
 * Record-then-announce helper shared by the contact + card `callSummary.add`
 * procedures. Resolves the contact name + the logging staff member, then posts
 * the summary to `#callsummaries`. Best-effort: a Slack failure returns a
 * `failed`/`skipped` result and never throws, so the CRM record (already
 * written) is never lost.
 */
export async function postCallSummaryToSlack(args: {
  contactId: string
  body: string
  outcome?: CallOutcome | null
  agentId: string
  requestId: string
}): Promise<ChannelResult> {
  const senders = buildCallSummarySenders({ agentId: args.agentId, requestId: args.requestId })
  if (!senders.slack) return { status: 'skipped', detail: 'Slack sender not configured' }

  const [contact, author] = await Promise.all([
    db.contact.findFirst({
      where: { id: args.contactId, deletedAt: null },
      select: { firstName: true, lastName: true },
    }),
    db.user.findUnique({ where: { id: args.agentId }, select: { name: true, email: true } }),
  ])
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || 'this contact'
  const authorName = author?.name?.trim() || author?.email || null

  try {
    return await senders.slack({
      body: args.body,
      contactName,
      contactId: args.contactId,
      outcome: args.outcome ?? null,
      authorName,
    })
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
