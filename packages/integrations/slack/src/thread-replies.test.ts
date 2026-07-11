import { describe, expect, it, vi } from 'vitest'

import { walkThread, type SlackHistoryMessage, type SlackHistoryResponse } from './backfill'

/** A thread root Slack returns from conversations.history (replies NOT inline). */
function root(overrides: Partial<SlackHistoryMessage> = {}): SlackHistoryMessage {
  return {
    type: 'message',
    ts: '1000.0001',
    user: 'U1',
    text: 'Sampada Neupane +447588744609 enrolled',
    reply_count: 2,
    ...overrides,
  }
}

describe('walkThread', () => {
  it('processes the root then each reply, skipping the root echoed by conversations.replies', async () => {
    const r = root()
    const replies: SlackHistoryResponse = {
      ok: true,
      messages: [
        // conversations.replies returns the ROOT first — must be skipped.
        { type: 'message', ts: '1000.0001', user: 'U1', text: r.text },
        { type: 'message', ts: '1001.0001', user: 'U2', text: 'paid £40 premium hour' },
        { type: 'message', ts: '1002.0001', user: 'U1', text: 'confirmed for Friday' },
      ],
      has_more: false,
    }
    const fetchReplies = vi.fn(async () => replies)
    const process = vi.fn(async () => ({ matched: true }))

    const tally = await walkThread(r, { fetchReplies, process })

    // root + 2 replies (root echo skipped) = 3 processed.
    expect(tally).toEqual({ processed: 3, matched: 3, skipped: 0 })
    expect(fetchReplies).toHaveBeenCalledTimes(1)
    expect(fetchReplies).toHaveBeenCalledWith('1000.0001', undefined)
    // Root processed with no parent; each reply inherits the root's text.
    expect(process).toHaveBeenNthCalledWith(1, r, null)
    expect(process).toHaveBeenNthCalledWith(2, replies.messages![1], r.text)
    expect(process).toHaveBeenNthCalledWith(3, replies.messages![2], r.text)
  })

  it('does not fetch replies for a plain (non-thread) message', async () => {
    const msg = root({ reply_count: 0, text: 'no customer here' })
    const fetchReplies = vi.fn(async (): Promise<SlackHistoryResponse> => ({ ok: true }))
    const process = vi.fn(async () => ({ matched: false }))

    const tally = await walkThread(msg, { fetchReplies, process })

    expect(fetchReplies).not.toHaveBeenCalled()
    expect(tally).toEqual({ processed: 1, matched: 0, skipped: 1 })
  })

  it('does not walk replies from a reply itself (thread_ts !== ts)', async () => {
    // A message that is itself a reply carries thread_ts pointing elsewhere.
    const reply = root({ ts: '1005.0001', thread_ts: '1000.0001', reply_count: 0 })
    const fetchReplies = vi.fn(async (): Promise<SlackHistoryResponse> => ({ ok: true }))
    const process = vi.fn(async () => ({ matched: true }))

    await walkThread(reply, { fetchReplies, process })
    expect(fetchReplies).not.toHaveBeenCalled()
  })

  it('paginates replies via next_cursor', async () => {
    const r = root({ reply_count: 3 })
    const page1: SlackHistoryResponse = {
      ok: true,
      messages: [
        { type: 'message', ts: r.ts, text: r.text },
        { type: 'message', ts: '1001.0001', text: 'a' },
      ],
      has_more: true,
      response_metadata: { next_cursor: 'CUR2' },
    }
    const page2: SlackHistoryResponse = {
      ok: true,
      messages: [{ type: 'message', ts: '1002.0001', text: 'b' }],
      has_more: false,
    }
    const fetchReplies = vi
      .fn<(threadTs: string, cursor: string | undefined) => Promise<SlackHistoryResponse>>()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
    const process = vi.fn(async () => ({ matched: true }))

    const tally = await walkThread(r, { fetchReplies, process })

    expect(fetchReplies).toHaveBeenNthCalledWith(1, r.ts, undefined)
    expect(fetchReplies).toHaveBeenNthCalledWith(2, r.ts, 'CUR2')
    // root + reply 'a' + reply 'b' = 3 (root echo on page1 skipped).
    expect(tally.processed).toBe(3)
  })

  it('a failed reply fetch does not abort — the root still counts', async () => {
    const r = root()
    const fetchReplies = vi.fn(async () => {
      throw new Error('missing_scope')
    })
    const process = vi.fn(async () => ({ matched: true }))

    const tally = await walkThread(r, { fetchReplies, process })
    expect(tally).toEqual({ processed: 1, matched: 1, skipped: 0 })
  })

  it('a single reply that throws is skipped, not fatal', async () => {
    const r = root()
    const replies: SlackHistoryResponse = {
      ok: true,
      messages: [
        { type: 'message', ts: r.ts, text: r.text },
        { type: 'message', ts: '1001.0001', text: 'boom' },
        { type: 'message', ts: '1002.0001', text: 'fine' },
      ],
      has_more: false,
    }
    const fetchReplies = vi.fn(async () => replies)
    const process = vi
      .fn<(message: SlackHistoryMessage, threadParentText: string | null) => Promise<{ matched: boolean }>>()
      .mockResolvedValueOnce({ matched: true }) // root
      .mockRejectedValueOnce(new Error('boom')) // reply 1
      .mockResolvedValueOnce({ matched: true }) // reply 2

    const tally = await walkThread(r, { fetchReplies, process })
    expect(tally).toEqual({ processed: 3, matched: 2, skipped: 1 })
  })
})
