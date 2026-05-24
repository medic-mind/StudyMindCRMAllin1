// Tests for the UEBA aggregator. Pure functions; no I/O.
// CLAUDE.md §44.3.

import { describe, expect, it } from 'vitest'

import {
  analyseUeba,
  hasHighSeverity,
  hourInTimezone,
  type UebaInput,
} from './ueba'

const baseInput: UebaInput = {
  dsarExports: [],
  refunds: [],
  failedSignIns: [],
  windowEnd: new Date('2026-05-11T04:00:00Z'),
}

describe('analyseUeba — off-hours DSAR', () => {
  it('flags a DSAR export at 23:30 UTC by default actor tz', () => {
    const r = analyseUeba({
      ...baseInput,
      dsarExports: [
        {
          actorId: 'u-1',
          occurredAt: new Date('2026-05-05T22:30:00Z'),
        },
      ],
    })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.category).toBe('off_hours_dsar')
  })

  it('respects the actor timezone — 02:00 UTC = 22:00 local in NYC', () => {
    const r = analyseUeba({
      ...baseInput,
      dsarExports: [
        {
          actorId: 'u-ny',
          occurredAt: new Date('2026-05-06T02:00:00Z'),
          actorTimezone: 'America/New_York',
        },
      ],
    })
    // 02:00 UTC = 22:00 EDT in May → off-hours
    expect(r.findings).toHaveLength(1)
  })

  it('does not flag during business hours', () => {
    const r = analyseUeba({
      ...baseInput,
      dsarExports: [
        {
          actorId: 'u-1',
          occurredAt: new Date('2026-05-06T11:00:00Z'),
        },
      ],
    })
    expect(r.findings).toHaveLength(0)
  })
})

describe('analyseUeba — refund clusters', () => {
  it('flags > 3 refunds by the same actor inside a 24h window', () => {
    const refunds = [0, 1, 2, 3].map((h) => ({
      actorId: 'u-finance',
      occurredAt: new Date(`2026-05-05T0${h}:00:00Z`),
    }))
    const r = analyseUeba({ ...baseInput, refunds })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.category).toBe('refund_cluster')
  })

  it('does not flag 3 refunds across 30h', () => {
    const refunds = [
      { actorId: 'u-f', occurredAt: new Date('2026-05-05T00:00:00Z') },
      { actorId: 'u-f', occurredAt: new Date('2026-05-05T15:00:00Z') },
      { actorId: 'u-f', occurredAt: new Date('2026-05-06T06:00:00Z') },
    ]
    const r = analyseUeba({ ...baseInput, refunds })
    expect(r.findings).toHaveLength(0)
  })
})

describe('analyseUeba — sign-in bursts', () => {
  it('flags > 5 failed sign-ins from one IP in 1 hour', () => {
    const failedSignIns = Array.from({ length: 6 }, (_, i) => ({
      ip: '1.2.3.4',
      occurredAt: new Date(`2026-05-05T10:${String(i * 5).padStart(2, '0')}:00Z`),
    }))
    const r = analyseUeba({ ...baseInput, failedSignIns })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.category).toBe('signin_burst')
  })

  it('does not flag 6 failed sign-ins across 2h', () => {
    const failedSignIns = Array.from({ length: 6 }, (_, i) => ({
      ip: '1.2.3.4',
      occurredAt: new Date(`2026-05-05T10:${String(i * 25).padStart(2, '0')}:00Z`),
    }))
    const r = analyseUeba({ ...baseInput, failedSignIns })
    // i*25 spans 0..125 minutes → outside the 1h window
    expect(r.findings).toHaveLength(0)
  })
})

describe('hasHighSeverity', () => {
  it('returns true if any finding is high', () => {
    const r = analyseUeba({
      ...baseInput,
      dsarExports: [{ actorId: 'u', occurredAt: new Date('2026-05-05T23:00:00Z') }],
    })
    expect(hasHighSeverity(r)).toBe(true)
  })

  it('returns false on empty findings', () => {
    expect(hasHighSeverity(analyseUeba(baseInput))).toBe(false)
  })
})

describe('hourInTimezone', () => {
  it('returns 22 for 22:00 UTC in UTC', () => {
    expect(hourInTimezone(new Date('2026-05-05T22:00:00Z'), 'UTC')).toBe(22)
  })
  it('returns 23 for 22:00 UTC in Europe/London (BST)', () => {
    expect(hourInTimezone(new Date('2026-05-05T22:00:00Z'), 'Europe/London')).toBe(23)
  })
})
