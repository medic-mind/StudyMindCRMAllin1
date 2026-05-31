// Tests for the Redis fixed-window rate-limit counter. ADR 0020 Phase 7b.

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Redis } from 'ioredis'

import {
  _resetForTests,
  _setRedisClientForTests,
  redisRateLimitAllow,
} from './redis-rate-limit'

afterEach(() => {
  _resetForTests()
  delete process.env['REDIS_URL']
})

describe('redisRateLimitAllow', () => {
  it('returns null when REDIS_URL is unset (caller falls back to memory)', async () => {
    const result = await redisRateLimitAllow({ key: 'u1:p', windowSec: 60, max: 5 })
    expect(result).toBeNull()
  })

  it('enforces the window against an injected client', async () => {
    // Fake Redis that runs the INCR + first-write-PEXPIRE semantics in JS.
    const counts = new Map<string, number>()
    const fake = {
      eval: vi.fn(async (_script: string, _numKeys: number, key: string) => {
        const next = (counts.get(key) ?? 0) + 1
        counts.set(key, next)
        return next
      }),
      on: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Redis
    _setRedisClientForTests(fake)

    const results: Array<boolean | null> = []
    for (let i = 0; i < 7; i += 1) {
      results.push(
        await redisRateLimitAllow({ key: 'u1:refund', windowSec: 60, max: 5 }),
      )
    }
    // First 5 allowed, 6th and 7th rejected.
    expect(results).toEqual([true, true, true, true, true, false, false])
  })

  it('keys independently per bucket key', async () => {
    const counts = new Map<string, number>()
    const fake = {
      eval: vi.fn(async (_script: string, _numKeys: number, key: string) => {
        const next = (counts.get(key) ?? 0) + 1
        counts.set(key, next)
        return next
      }),
      on: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Redis
    _setRedisClientForTests(fake)

    await redisRateLimitAllow({ key: 'rl:u1:p', windowSec: 60, max: 1 })
    // Different user → different key → still allowed.
    expect(
      await redisRateLimitAllow({ key: 'u2:p', windowSec: 60, max: 1 }),
    ).toBe(true)
  })

  it('returns null when the client throws (degrade to memory)', async () => {
    const fake = {
      eval: vi.fn(async () => {
        throw new Error('connection reset')
      }),
      on: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as Redis
    _setRedisClientForTests(fake)
    expect(
      await redisRateLimitAllow({ key: 'u1:p', windowSec: 60, max: 5 }),
    ).toBeNull()
  })
})
