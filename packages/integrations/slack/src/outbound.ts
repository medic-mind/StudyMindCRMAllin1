// Outbound calls TO Slack. CLAUDE.md §12.
// Single bot user, single channel `#crm-alerts` (id from
// SLACK_ALERTS_CHANNEL_ID). Idempotent on the caller-supplied key — replays
// return the existing slackTs rather than double-posting.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'

import { createClient, type SlackClient } from './client.js'
import { getAlertsChannelId } from './config.js'

export interface OutboundContext {
  actorId: string
  requestId: string
}

export interface PostAlertInput {
  message: string
  blocks?: unknown[]
  /** Idempotency key (CLAUDE.md §17). */
  idempotencyKey: string
  ctx: OutboundContext
  /** Optional channel override; defaults to SLACK_ALERTS_CHANNEL_ID. */
  channelId?: string
  /** Test seam. */
  client?: SlackClient
}

export interface PostAlertResult {
  slackTs: string
  channelId: string
  /** True iff this call resulted in a fresh Slack post. */
  posted: boolean
}

export async function postAlert(input: PostAlertInput): Promise<PostAlertResult> {
  const channelId = input.channelId ?? getAlertsChannelId()
  if (!channelId) throw new Error('SLACK_ALERTS_CHANNEL_ID is not set')

  // Idempotency: if we have already posted for this key, return the cached
  // slackTs. CLAUDE.md §17.
  const existing = await db.slackPost.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
    select: { slackTs: true, channelId: true },
  })
  if (existing) {
    return { slackTs: existing.slackTs, channelId: existing.channelId, posted: false }
  }

  const client = input.client ?? createClient()
  const result = await client.chatPostMessage({
    channel: channelId,
    text: input.message,
    ...(input.blocks ? { blocks: input.blocks } : {}),
  })

  // Persist BEFORE writing audit so a partial-failure on audit does not
  // cause a duplicate Slack post on retry.
  await db.slackPost.create({
    data: {
      idempotencyKey: input.idempotencyKey,
      slackTs: result.ts,
      channelId: result.channel,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'slack.alert_posted',
    target: { type: 'SlackPost', id: input.idempotencyKey },
    requestId: input.ctx.requestId,
    after: { channelId: result.channel, slackTs: result.ts },
  })

  return { slackTs: result.ts, channelId: result.channel, posted: true }
}
