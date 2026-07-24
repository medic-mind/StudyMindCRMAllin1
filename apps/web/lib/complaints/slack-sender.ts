// Slack sender for complaints LOGGED IN THE CRM → the operator-routed
// #complaintcallsummaries channel. Complaints are always logged in the CRM now
// (Slack auto-ingestion was removed, 2026-07); logging one posts a message via
// the connected bot, and each complaint anchors a Slack THREAD so follow-up
// updates reply under it. Works for a linked CRM contact OR a manually-typed
// person (name/phone). Domain code (packages/core) is pure and can't import
// integration clients, so the tRPC layer supplies this. Best-effort: a Slack
// failure never fails logging the complaint.

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
  /** The posted message ts + channel — stored on the complaint so thread
   *  updates reply under it. Present only when status === 'sent'. */
  slackTs?: string
  channelId?: string
}

/**
 * Announce a newly-logged complaint to the operator-routed complaint channel
 * (`complaint_call_summary` topic → the configured channel → SLACK_ALERTS_CHANNEL_ID).
 * Returns the message ts + channel so the caller can anchor the thread.
 * Idempotent on the complaint id.
 */
export async function postComplaintToSlack(args: {
  complaintId: string
  contactId?: string | null
  personName?: string | null
  personPhone?: string | null
  personEmail?: string | null
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
      detail: 'No Slack channel configured for complaints (Settings → Slack channels)',
    }
  }

  const [contact, author] = await Promise.all([
    args.contactId
      ? db.contact.findFirst({
          where: { id: args.contactId, deletedAt: null },
          select: { firstName: true, lastName: true, email: true, phoneE164: true },
        })
      : Promise.resolve(null),
    db.user.findUnique({ where: { id: args.agentId }, select: { name: true, email: true } }),
  ])
  const contactName =
    [contact?.firstName, contact?.lastName].filter(Boolean).join(' ').trim() ||
    args.personName?.trim() ||
    'this customer'

  const slackArgs: ComplaintSlackArgs = {
    contactName,
    contactEmail: contact?.email ?? args.personEmail ?? null,
    contactPhone: contact?.phoneE164 ?? args.personPhone ?? null,
    title: args.title,
    description: args.description ?? null,
    category: args.category ?? null,
    severity: args.severity ?? null,
    // Link to the complaint's own detail page — canonical and works whether or
    // not a CRM contact is linked.
    contactUrl: `${appUrl()}/complaints/${args.complaintId}`,
    authorName: author?.name?.trim() || author?.email || null,
  }

  try {
    const { postAlert } = await import('@studymind/integration-slack/outbound')
    const res = await postAlert({
      message: buildComplaintSlackText(slackArgs),
      blocks: buildComplaintSlackBlocks(slackArgs),
      idempotencyKey: `complaint:${args.complaintId}`,
      channelId,
      ctx: { actorId: args.agentId, requestId: args.requestId },
    })
    return { status: 'sent', slackTs: res.slackTs, channelId: res.channelId }
  } catch (err) {
    return { status: 'failed', detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Mirror a CRM complaint-thread update into its Slack thread (a reply under the
 * original complaint message). Best-effort — a failure never blocks the update
 * being saved. Idempotent on the update id.
 */
export async function postComplaintThreadReply(args: {
  complaintId: string
  updateId: string
  channelId: string
  threadTs: string
  body: string
  isActionPoint?: boolean
  authorName?: string | null
  agentId: string
  requestId: string
}): Promise<{ status: 'sent' | 'failed' }> {
  const prefix = args.isActionPoint ? '✅ Action: ' : ''
  const by = args.authorName?.trim() ? ` — ${args.authorName.trim()}` : ''
  try {
    const { postAlert } = await import('@studymind/integration-slack/outbound')
    await postAlert({
      message: `${prefix}${args.body}${by}`.slice(0, 2900),
      idempotencyKey: `complaint-update:${args.updateId}`,
      channelId: args.channelId,
      threadTs: args.threadTs,
      ctx: { actorId: args.agentId, requestId: args.requestId },
    })
    return { status: 'sent' }
  } catch {
    return { status: 'failed' }
  }
}
