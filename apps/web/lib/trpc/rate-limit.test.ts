// Tests for the per-procedure rate limiter. CLAUDE.md §27.

import { describe, expect, it, beforeEach } from 'vitest'

import { __resetRateLimitForTests, rateLimit } from './rate-limit'

describe('rateLimit', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
  })

  it('uses the default read limit (60/min) for unlisted procedures', async () => {
    let allowed = 0
    for (let i = 0; i < 65; i += 1) {
      const ok = await rateLimit({ userId: 'u1', procedure: 'nonexistent.procedure' })
      if (ok) allowed += 1
    }
    expect(allowed).toBe(60)
  })

  it('applies the strict 5/min limit on sensitive writes (refund.create)', async () => {
    let allowed = 0
    for (let i = 0; i < 10; i += 1) {
      const ok = await rateLimit({ userId: 'u1', procedure: 'finance.refund.create' })
      if (ok) allowed += 1
    }
    expect(allowed).toBe(5)
  })

  it('applies the standard 10/min write limit on contact.create', async () => {
    let allowed = 0
    for (let i = 0; i < 12; i += 1) {
      const ok = await rateLimit({ userId: 'u1', procedure: 'contact.create' })
      if (ok) allowed += 1
    }
    expect(allowed).toBe(10)
  })

  it('keys per user (one user hitting the cap does not block another)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await rateLimit({ userId: 'u1', procedure: 'finance.refund.create' })
    }
    expect(await rateLimit({ userId: 'u1', procedure: 'finance.refund.create' })).toBe(false)
    expect(await rateLimit({ userId: 'u2', procedure: 'finance.refund.create' })).toBe(true)
  })

  it('honours an explicit override', async () => {
    expect(
      await rateLimit({
        userId: 'u1',
        procedure: 'anything',
        limit: { windowSec: 60, max: 1 },
      }),
    ).toBe(true)
    expect(
      await rateLimit({
        userId: 'u1',
        procedure: 'anything',
        limit: { windowSec: 60, max: 1 },
      }),
    ).toBe(false)
  })
})
