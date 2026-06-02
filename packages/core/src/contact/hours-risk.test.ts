import { describe, expect, it } from 'vitest'

import {
  DEFAULT_HOURS_RISK_CONFIG,
  deriveHoursRisk,
  type HoursRiskInput,
} from './hours-risk'

const NOW = new Date('2026-06-01T00:00:00.000Z')

function daysFromNow(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000)
}

function base(overrides: Partial<HoursRiskInput> = {}): HoursRiskInput {
  return {
    hoursBooked: 20,
    hoursDelivered: 18,
    hoursRemaining: 2,
    lastLessonAt: daysFromNow(-3),
    nextHoursExpiryAt: null,
    ...overrides,
  }
}

describe('deriveHoursRisk', () => {
  it('is not at risk when remaining hours are below the floor', () => {
    const r = deriveHoursRisk(base({ hoursRemaining: 2 }), NOW)
    expect(r.level).toBe('none')
    expect(r.reasons).toHaveLength(0)
  })

  it('flags heavy under-use (lots booked, little used)', () => {
    const r = deriveHoursRisk(
      base({ hoursBooked: 30, hoursDelivered: 3, hoursRemaining: 27, lastLessonAt: daysFromNow(-2) }),
      NOW,
    )
    expect(r.reasons.some((x) => x.signal === 'underuse')).toBe(true)
    expect(r.score).toBeGreaterThan(0.5)
    expect(['medium', 'high']).toContain(r.level)
  })

  it('flags idle customers sitting on a balance', () => {
    const r = deriveHoursRisk(
      base({ hoursBooked: 20, hoursDelivered: 8, hoursRemaining: 12, lastLessonAt: daysFromNow(-90) }),
      NOW,
    )
    expect(r.reasons.some((x) => x.signal === 'idle')).toBe(true)
  })

  it('treats never-had-a-lesson-but-holds-hours as idle', () => {
    const r = deriveHoursRisk(
      base({ hoursBooked: 20, hoursDelivered: 0, hoursRemaining: 20, lastLessonAt: null }),
      NOW,
    )
    expect(r.reasons.some((x) => x.signal === 'idle')).toBe(true)
    // Also heavily under-used → should be high.
    expect(r.level).toBe('high')
  })

  it('flags imminent expiry with a meaningful balance', () => {
    const r = deriveHoursRisk(
      base({
        hoursBooked: 20,
        hoursDelivered: 10,
        hoursRemaining: 10,
        lastLessonAt: daysFromNow(-2),
        nextHoursExpiryAt: daysFromNow(20),
      }),
      NOW,
    )
    expect(r.reasons.some((x) => x.signal === 'expiry')).toBe(true)
    expect(r.daysToExpiry).toBe(20)
  })

  it('treats already-overdue expiry as maximal expiry severity', () => {
    const r = deriveHoursRisk(
      base({
        hoursBooked: 20,
        hoursDelivered: 10,
        hoursRemaining: 10,
        lastLessonAt: daysFromNow(-2),
        nextHoursExpiryAt: daysFromNow(-1),
      }),
      NOW,
    )
    const expiry = r.reasons.find((x) => x.signal === 'expiry')
    expect(expiry?.severity).toBe(1)
    expect(r.level).toBe('high')
  })

  it('combines under-use + imminent expiry into a high score', () => {
    const r = deriveHoursRisk(
      base({
        hoursBooked: 40,
        hoursDelivered: 4,
        hoursRemaining: 36,
        lastLessonAt: daysFromNow(-10),
        nextHoursExpiryAt: daysFromNow(15),
      }),
      NOW,
    )
    expect(r.level).toBe('high')
    expect(r.reasons.length).toBeGreaterThanOrEqual(2)
    // Strongest reason is surfaced first.
    expect(r.reasons[0]!.severity).toBeGreaterThanOrEqual(r.reasons[1]!.severity)
  })

  it('falls back to booked-minus-delivered when remaining is null', () => {
    const r = deriveHoursRisk(
      base({ hoursBooked: 30, hoursDelivered: 5, hoursRemaining: null, lastLessonAt: daysFromNow(-2) }),
      NOW,
    )
    expect(r.hoursRemaining).toBe(25)
    expect(r.reasons.some((x) => x.signal === 'underuse')).toBe(true)
  })

  it('respects a custom config', () => {
    // Tighten the floor so a 12h balance no longer qualifies.
    const r = deriveHoursRisk(
      base({ hoursBooked: 20, hoursDelivered: 8, hoursRemaining: 12, lastLessonAt: daysFromNow(-200) }),
      NOW,
      { ...DEFAULT_HOURS_RISK_CONFIG, minRemainingHours: 15 },
    )
    expect(r.level).toBe('none')
  })

  it('is healthy for an active, well-used customer', () => {
    const r = deriveHoursRisk(
      base({
        hoursBooked: 20,
        hoursDelivered: 17,
        hoursRemaining: 3,
        lastLessonAt: daysFromNow(-1),
        nextHoursExpiryAt: daysFromNow(300),
      }),
      NOW,
    )
    expect(r.level).toBe('none')
  })
})
