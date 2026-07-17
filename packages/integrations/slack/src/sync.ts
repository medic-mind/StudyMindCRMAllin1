// Recurring + on-demand Slack message PULL (not just the Events webhook).
//
// The Events API push only delivers if the Slack app's event subscription is
// configured AND the bot is invited to each channel. To make ingestion robust —
// "show everything the bot can read" — this pulls recent messages from EVERY
// channel the bot is a member of (auto-discovered), on a schedule and on demand,
// using the bot token directly. Reuses the backfill's per-message processor, so
// a customer-referencing message is matched + linked exactly the same way.
//
// Robustness (the reasons messages used to vanish silently):
//   - Channels are isolated: one channel failing (rate limit, kicked mid-walk)
//     no longer aborts the rest of the tick. Channels walk alphabetically, so
//     the old behaviour dropped every later-alphabet channel whenever an early
//     one threw — the classic "some messages captured, some never" fingerprint.
//   - Slack 429s are retried with Retry-After (see slackApiGet in backfill.ts)
//     instead of killing the walk.
//   - Replies to OLDER threads are scanned: conversations.history only returns
//     thread ROOTS, so a fresh reply on a thread started before the lookback
//     window was structurally invisible to the pull. Each tick now also checks
//     recent roots (up to SLACK_SYNC_THREAD_SCAN_DAYS back) whose latest_reply
//     falls inside the window, and walks just those new replies.
//   - Failed channels are counted + logged in the run result so a broken pull
//     is visible in the Inngest dashboard instead of reading as "no news".
//
// Dedup: processSlackMessage is idempotent on (channelId, ts) for matched
// messages. We keep the overlap window bounded so unmatched messages aren't
// re-classified by the AI too many times (§32 cost control).

import { inngest } from '@studymind/jobs'

import {
  fetchHistory,
  fetchReplies,
  processMessageWithReplies,
  processSlackMessage,
  walkThread,
  type SlackHistoryMessage,
  type SlackHistoryResponse,
  type WalkTally,
} from './backfill'
import { listIngestChannelIds } from './client'

/** How far back each pull looks. Overlaps the 15-min cadence many times over so
 *  a failed tick (deploy, rate-limit storm) self-heals on the next one; the
 *  overlap costs only cheap DB dedupe checks, never AI re-spend. */
const LOOKBACK_MIN = Number(process.env['SLACK_SYNC_LOOKBACK_MINUTES'] ?? 120)
/** Pages of history per channel per run (100 msgs/page). */
const MAX_PAGES = 3
/** Old-thread scan: how far back a thread ROOT may sit and still have fresh
 *  replies picked up by the pull. */
const THREAD_SCAN_DAYS = Number(process.env['SLACK_SYNC_THREAD_SCAN_DAYS'] ?? 7)
/** Pages of history inspected by the old-thread scan (roots only, no AI). */
const THREAD_SCAN_PAGES = 2
/** Old threads with fresh replies walked per channel per tick. */
const OLD_THREADS_PER_CHANNEL = 15

interface PullLogger {
  info?: (obj: unknown, msg?: string) => void
  warn?: (obj: unknown, msg?: string) => void
}

/** Injectable I/O so channel-walk orchestration is unit-testable. */
export interface PullDeps {
  listChannels: () => Promise<string[]>
  fetchHistory: (
    channelId: string,
    oldest: number,
    cursor: string | undefined,
  ) => Promise<SlackHistoryResponse>
  /** Process one windowed message and (for thread roots) its replies. */
  processMessage: (channelId: string, message: SlackHistoryMessage) => Promise<WalkTally>
  /** Walk ONLY the replies of an old thread root that arrived at/after
   *  `repliesOldest` (the root itself is re-checked cheaply too). */
  walkOldThread: (
    channelId: string,
    root: SlackHistoryMessage,
    repliesOldest: number,
  ) => Promise<WalkTally>
}

function realDeps(token: string, requestId: string): PullDeps {
  return {
    listChannels: () => listIngestChannelIds({ token }),
    fetchHistory: (channelId, oldest, cursor) => fetchHistory(token, channelId, oldest, cursor),
    processMessage: (channelId, message) =>
      processMessageWithReplies({ token, channelId, message, requestId }),
    walkOldThread: (channelId, root, repliesOldest) =>
      walkThread(root, {
        fetchReplies: (threadTs, cursor) =>
          fetchReplies(token, channelId, threadTs, cursor, repliesOldest),
        process: (msg, threadParentText) =>
          processSlackMessage({ message: msg, channelId, requestId, threadParentText }),
      }),
  }
}

/** True for a thread ROOT that started before the window but has at least one
 *  reply inside it — the case conversations.history hides from a windowed pull. */
export function isOldThreadWithFreshReplies(
  m: SlackHistoryMessage,
  sinceUnix: number,
): boolean {
  if ((m.reply_count ?? 0) < 1) return false
  if (m.thread_ts && m.thread_ts !== m.ts) return false // a reply, not a root
  const rootTs = Number(m.ts)
  const latest = Number(m.latest_reply ?? 0)
  return rootTs < sinceUnix && latest >= sinceUnix
}

/** Walk one channel: the lookback window first, then the old-thread scan.
 *  Throws only when the channel is entirely unreadable — the caller isolates. */
async function pullChannel(input: {
  channelId: string
  sinceUnix: number
  deps: PullDeps
  logger?: PullLogger
}): Promise<{ processed: number; matched: number }> {
  const { channelId, sinceUnix, deps } = input
  let processed = 0
  let matched = 0

  // 1. Everything inside the lookback window (roots + their replies).
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await deps.fetchHistory(channelId, sinceUnix, cursor)
    for (const m of res.messages ?? []) {
      try {
        const r = await deps.processMessage(channelId, m)
        processed += r.processed
        matched += r.matched
      } catch (err) {
        input.logger?.warn?.({ channelId, ts: m.ts, err }, 'slack sync: skipped a message')
      }
    }
    cursor = res.has_more ? res.response_metadata?.next_cursor : undefined
    if (!cursor) break
  }

  // 2. Fresh replies on threads whose root pre-dates the window.
  const scanOldest = sinceUnix - THREAD_SCAN_DAYS * 86_400
  const oldRoots: SlackHistoryMessage[] = []
  let scanCursor: string | undefined
  for (let page = 0; page < THREAD_SCAN_PAGES; page += 1) {
    const res = await deps.fetchHistory(channelId, scanOldest, scanCursor)
    for (const m of res.messages ?? []) {
      if (isOldThreadWithFreshReplies(m, sinceUnix)) oldRoots.push(m)
    }
    scanCursor = res.has_more ? res.response_metadata?.next_cursor : undefined
    if (!scanCursor) break
  }
  for (const root of oldRoots.slice(0, OLD_THREADS_PER_CHANNEL)) {
    try {
      const r = await deps.walkOldThread(channelId, root, sinceUnix)
      processed += r.processed
      matched += r.matched
    } catch (err) {
      input.logger?.warn?.(
        { channelId, threadTs: root.ts, err },
        'slack sync: skipped an old-thread reply walk',
      )
    }
  }

  return { processed, matched }
}

export interface PullResult {
  channels: number
  processed: number
  matched: number
  /** Channels whose walk failed entirely this tick (rate-limit exhaustion,
   *  revoked access, …). Non-empty = look at the logs; the rest of the tick
   *  still ran. */
  failedChannels: string[]
}

export async function pullRecentSlack(input: {
  token: string
  sinceUnix: number
  requestId: string
  logger?: PullLogger
  /** Test seam — omit in production for the real Slack-backed deps. */
  deps?: PullDeps
}): Promise<PullResult> {
  const deps = input.deps ?? realDeps(input.token, input.requestId)
  const channels = await deps.listChannels()
  let processed = 0
  let matched = 0
  const failedChannels: string[] = []
  for (const channelId of channels) {
    try {
      const r = await pullChannel({
        channelId,
        sinceUnix: input.sinceUnix,
        deps,
        logger: input.logger,
      })
      processed += r.processed
      matched += r.matched
    } catch (err) {
      // One unreadable channel must never cost the rest of the workspace its
      // tick (the old behaviour, and the root cause of "randomly missing"
      // messages). Record + continue.
      failedChannels.push(channelId)
      input.logger?.warn?.({ channelId, err }, 'slack sync: channel walk failed — continuing')
    }
  }
  return { channels: channels.length, processed, matched, failedChannels }
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
