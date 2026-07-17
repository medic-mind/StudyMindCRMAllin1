// Pins the pull's robustness contract: one failing channel never costs the
// rest of the workspace its tick, and fresh replies on threads older than the
// lookback window are still walked (conversations.history hides them).

import { describe, expect, it } from 'vitest'

import type { SlackHistoryMessage } from './backfill'
import { isOldThreadWithFreshReplies, pullRecentSlack, type PullDeps } from './sync'

function msg(ts: string, overrides: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage {
  return { type: 'message', ts, user: 'U1', text: 'hello there person', ...overrides }
}

const noTally = { processed: 0, matched: 0, skipped: 0 }

describe('isOldThreadWithFreshReplies', () => {
  it('spots a pre-window root with a reply inside the window', () => {
    expect(
      isOldThreadWithFreshReplies(msg('500.1', { reply_count: 2, latest_reply: '1500.9' }), 1000),
    ).toBe(true)
  })

  it('ignores roots already inside the window (the main walk covers them)', () => {
    expect(
      isOldThreadWithFreshReplies(msg('1500.1', { reply_count: 2, latest_reply: '1600.9' }), 1000),
    ).toBe(false)
  })

  it('ignores plain messages, replies, and threads with no fresh replies', () => {
    expect(isOldThreadWithFreshReplies(msg('500.1'), 1000)).toBe(false)
    expect(
      isOldThreadWithFreshReplies(
        msg('500.5', { thread_ts: '400.1', reply_count: 1, latest_reply: '1500.9' }),
        1000,
      ),
    ).toBe(false)
    expect(
      isOldThreadWithFreshReplies(msg('500.1', { reply_count: 2, latest_reply: '900.0' }), 1000),
    ).toBe(false)
  })
})

describe('pullRecentSlack', () => {
  it('isolates a failing channel instead of aborting the whole tick', async () => {
    const processed: string[] = []
    const deps: PullDeps = {
      listChannels: async () => ['CBAD', 'CGOOD'],
      fetchHistory: async (channelId) => {
        if (channelId === 'CBAD') throw new Error('ratelimited')
        return { ok: true, messages: [msg('2000.1')], has_more: false }
      },
      processMessage: async (channelId, m) => {
        processed.push(`${channelId}:${m.ts}`)
        return { processed: 1, matched: 1, skipped: 0 }
      },
      walkOldThread: async () => noTally,
    }

    const res = await pullRecentSlack({ token: 't', sinceUnix: 1000, requestId: 'test', deps })

    expect(res.failedChannels).toEqual(['CBAD'])
    expect(res.channels).toBe(2)
    expect(processed).toEqual(['CGOOD:2000.1'])
    expect(res.processed).toBe(1)
    expect(res.matched).toBe(1)
  })

  it('walks fresh replies on threads older than the window, bounded to the window', async () => {
    const oldRoot = msg('500.1', { reply_count: 3, latest_reply: '1500.9' })
    const walked: string[] = []
    const deps: PullDeps = {
      listChannels: async () => ['C1'],
      fetchHistory: async (_channelId, oldest) =>
        oldest === 1000
          ? { ok: true, messages: [], has_more: false } // lookback window: quiet
          : { ok: true, messages: [oldRoot, msg('400.2')], has_more: false }, // scan
      processMessage: async () => noTally,
      walkOldThread: async (_channelId, root, repliesOldest) => {
        walked.push(`${root.ts}@${repliesOldest}`)
        return { processed: 2, matched: 1, skipped: 1 }
      },
    }

    const res = await pullRecentSlack({ token: 't', sinceUnix: 1000, requestId: 'test', deps })

    expect(walked).toEqual(['500.1@1000'])
    expect(res.processed).toBe(2)
    expect(res.matched).toBe(1)
    expect(res.failedChannels).toEqual([])
  })

  it('a message that fails to process is skipped without sinking its channel', async () => {
    const processed: string[] = []
    const deps: PullDeps = {
      listChannels: async () => ['C1'],
      fetchHistory: async (_c, oldest) =>
        oldest === 1000
          ? { ok: true, messages: [msg('2000.1'), msg('2000.2')], has_more: false }
          : { ok: true, messages: [], has_more: false },
      processMessage: async (_c, m) => {
        if (m.ts === '2000.1') throw new Error('ai exploded')
        processed.push(m.ts)
        return { processed: 1, matched: 0, skipped: 1 }
      },
      walkOldThread: async () => noTally,
    }

    const res = await pullRecentSlack({ token: 't', sinceUnix: 1000, requestId: 'test', deps })

    expect(processed).toEqual(['2000.2'])
    expect(res.failedChannels).toEqual([])
  })
})
