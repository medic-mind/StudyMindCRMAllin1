// Pins the Slack read-call rate-limit contract: 429/ratelimited responses are
// retried honouring Retry-After (bounded), any other error throws immediately.
// The old behaviour threw on the FIRST 429, which killed the whole pull tick —
// the root cause of "randomly missing" messages on busy workspaces.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchHistory, retryWaitSeconds } from './backfill'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('retryWaitSeconds', () => {
  it('falls back to the default when Retry-After is missing or empty — Number(null) is 0, which would busy-loop', () => {
    expect(retryWaitSeconds(null)).toBe(10)
    expect(retryWaitSeconds('')).toBe(10)
    expect(retryWaitSeconds('  ')).toBe(10)
    expect(retryWaitSeconds('soon')).toBe(10)
    expect(retryWaitSeconds('-5')).toBe(10)
  })

  it('honours a real header, capped at 60s', () => {
    expect(retryWaitSeconds('0')).toBe(0)
    expect(retryWaitSeconds('7')).toBe(7)
    expect(retryWaitSeconds('600')).toBe(60)
  })
})

describe('slack read calls under rate limiting', () => {
  it('retries a 429 honouring Retry-After, then succeeds', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        if (calls === 1) {
          return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        }
        return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 })
      }),
    )

    const res = await fetchHistory('token', 'C1', 0, undefined)

    expect(res.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('throws immediately on a non-rate-limit error', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ ok: false, error: 'not_in_channel' }), {
          status: 200,
        })
      }),
    )

    await expect(fetchHistory('token', 'C1', 0, undefined)).rejects.toThrow('not_in_channel')
    expect(calls).toBe(1)
  })

  it('gives up after bounded attempts when rate limiting persists', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return new Response('', { status: 429, headers: { 'retry-after': '0' } })
      }),
    )

    await expect(fetchHistory('token', 'C1', 0, undefined)).rejects.toThrow(/http_429/)
    expect(calls).toBe(6)
  })
})
