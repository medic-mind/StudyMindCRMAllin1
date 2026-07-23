// Slack sender for a complaint LOGGED IN THE CRM → the operator-routed
// #complaintcallsummaries channel (the reverse of the Slack→CRM complaint
// import, so typing a complaint in Slack and logging one here do the same
// thing). Domain code (packages/core) is pure and can't import integration
// clients, so the tRPC layer supplies this. Best-effort: a Slack failure never
// fails logging the complaint (the CRM record is already written).

import {
  buildComplaintSlackBlocks,
  buildComplaintSlackText,
  resolveTopicChannelId,
  type ComplaintSlackArgs,
} from '@studymind/core/slack'

import { db } from '@/lib/db'

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

export interface ComplaintSlackResult {
  status: 'sent' | 'skipped' | 'failed'
  detail?: string
}

/**
 * Announce a complaint to the operator-routed complaint channel. Routing is via
 * the ADR 0033 topic router (`complaint_call_summary` → the configured channel
 * → the default option → SLACK_ALERTS_CHANNEL_ID), so the destination is set in
 * Settings → Slack channels and never hardcoded. Idempotent on the complaint id.
 */
export async function postComplaintToSlack(args: {
  complaintId: string
  contactId: string
  title: string
  description?: string | null
  category?: string | null
  severity?: string | null
  agentId: string
  requestId: string
}): Promise<ComplaintSlackResult> {
  const channelId = await resolveTopicChannelId(db, 'complaint_call_summary')
  if (!channelId) {
    return {
      status: 'skipped',
      detail: 'No Slack channel configured for complaint call summaries (Settings → Slack channels)',
    }
  }

  const [contact, author] = await Promise.all([
    db.contact.findFirst({
      where: { id: args.contactId, deletedAt: null },
      select: { firstName: true, lastName: true, email: true, phoneE164: true },
    }),
    db.user.findUnique({ where: { id: args.agentId }, select: { name: true, email: true } }),
  ])
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() || 'this contact'

  const slackArgs: ComplaintSlackArgs = {
    contactName,
    contactEmail: contact?.email ?? null,
    contactPhone: contact?.phoneE164 ?? null,
    title: args.title,
    description: args.description ?? null,
    category: args.category ?? null,
    severity: args.severity ?? null,
    contactUrl: `${appUrl()}/contacts/${args.contactId}`,
    authorName: author?.name?.trim() || author?.email || null,
  }

  try {
    const { postAlert } = await import('@studymind/integration-slack/outbound')
    await postAlert({
      message: buildComplaintSlackText(slackArgs),
      blocks: buildComplaintSlackBlocks(slackArgs),
      idempotencyKey: `complaint:${args.complaintId}`,
      channelId,
      ctx: { actorId: args.agentId, requestId: args.requestId },
    })
    return { status: 'sent' }
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}
