// Recurring + on-demand Slack message PULL (not just the Events webhook).
//
// The Events API push only delivers if the Slack app's event subscription is
// configured AND the bot is invited to each channel. To make ingestion robust —
// "show everything the bot can read" — this pulls recent messages from EVERY
// channel the bot is a member of (auto-discovered), on a schedule and on demand,
// using the bot token directly. Reuses the backfill's per-message processor, so
// a customer-referencing message is matched + linked exactly the same way.
//
// Dedup: processSlackMessage is idempotent on (channelId, ts) for matched
// messages. We keep the overlap window short so unmatched messages aren't
// re-classified by the AI too many times (§32 cost control).

import { inngest } from '@studymind/jobs'

import { fetchHistory, processSlackMessage } from './backfill'
import { listIngestChannelIds } from './client'

/** How far back each pull looks. Kept short (overlaps the 15-min cadence ~2×) so
 *  the AI isn't re-run on unmatched chatter repeatedly. Bigger gaps are covered
 *  by the on-demand "Import history" backfill. */
const LOOKBACK_MIN = Number(process.env['SLACK_SYNC_LOOKBACK_MINUTES'] ?? 30)
/** Pages of history per channel per run (100 msgs/page). */
const MAX_PAGES = 3

interface PullLogger {
  info?: (obj: unknown, msg?: string) => void
  warn?: (obj: unknown, msg?: string) => void
}

export async function pullRecentSlack(input: {
  token: string
  sinceUnix: number
  requestId: string
  logger?: PullLogger
}): Promise<{ channels: number; processed: number; matched: number }> {
  const channels = await listIngestChannelIds({ token: input.token })
  let processed = 0
  let matched = 0
  for (const channelId of channels) {
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const res = await fetchHistory(input.token, channelId, input.sinceUnix, cursor)
      for (const m of res.messages ?? []) {
        try {
          const r = await processSlackMessage({ message: m, channelId, requestId: input.requestId })
          processed += 1
          if (r.matched) matched += 1
        } catch (err) {
          input.logger?.warn?.({ channelId, ts: m.ts, err }, 'slack sync: skipped a message')
        }
      }
      cursor = res.has_more ? res.response_metadata?.next_cursor : undefined
      if (!cursor) break
    }
  }
  return { channels: channels.length, processed, matched }
}

export const slackSyncMessages = inngest.createFunction(
  {
    id: 'slack/sync-messages',
    name: 'Pull recent Slack messages from every bot channel',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    const token = process.env['SLACK_BOT_TOKEN']
    if (!token) {
      logger.warn('SLACK_BOT_TOKEN not set; skipping slack sync')
      return { skipped: true, reason: 'no_token' as const }
    }
    const sinceUnix = Math.floor((Date.now() - LOOKBACK_MIN * 60_000) / 1000)
    const res = await step.run('pull', async () =>
      pullRecentSlack({ token, sinceUnix, requestId: 'slack-sync', logger }),
    )
    logger.info(res, 'slack sync-messages complete')
    return res
  },
)

/** On-demand "Sync from Slack now" — fired by the admin button. Accepts an
 *  optional `lookbackMinutes` so a manual sync can reach back further. */
export const slackSyncNow = inngest.createFunction(
  {
    id: 'slack/sync-now',
    name: 'Pull recent Slack messages on demand',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: 'slack/sync-now.requested' },
  async ({ event, step, logger }) => {
    const token = process.env['SLACK_BOT_TOKEN']
    if (!token) return { skipped: true as const, reason: 'no_token' }
    const lookbackMin = Number(
      (event.data as { lookbackMinutes?: number } | undefined)?.lookbackMinutes ?? LOOKBACK_MIN,
    )
    const sinceUnix = Math.floor((Date.now() - lookbackMin * 60_000) / 1000)
    const res = await step.run('pull', async () =>
      pullRecentSlack({ token, sinceUnix, requestId: 'slack-sync-now', logger }),
    )
    logger.info(res, 'slack sync-now complete')
    return res
  },
)

export const SYNC_FUNCTIONS = [slackSyncMessages, slackSyncNow] as const
