import { describe, expect, it } from 'vitest'

import { effectiveRetention, isExpired } from './retention'

describe('effectiveRetention', () => {
  it('returns the system default when no DOB and no contract override', () => {
    const r = effectiveRetention({
      flagId: 'f-1',
      contactDob: null,
      defaultDays: 365,
    })
    expect(r.retentionDays).toBe(365)
    expect(r.anchor).toBe('created_at')
  })

  it('returns 25y from DOB when DOB is known and no override', () => {
    const r = effectiveRetention({
      flagId: 'f-1',
      contactDob: new Date('2010-01-01'),
      defaultDays: 365,
    })
    expect(r.retentionDays).toBe(25 * 365)
    expect(r.anchor).toBe('dob')
  })

  it('LA contract override wins over the DOB default', () => {
    const r = effectiveRetention({
      flagId: 'f-1',
      contactDob: new Date('2010-01-01'),
      defaultDays: 365,
      contractOverrideDays: 30 * 365,
    })
    expect(r.retentionDays).toBe(30 * 365)
    expect(r.anchor).toBe('dob')
  })
})

describe('isExpired', () => {
  it('not expired one day after creation under default', () => {
    const created = new Date('2026-01-01')
    expect(
      isExpired({
        flagId: 'f',
        contactDob: null,
        defaultDays: 365,
        createdAt: created,
        now: new Date('2026-01-02'),
      }),
    ).toBe(false)
  })

  it('expired one day after the anchor + retentionDays', () => {
    const dob = new Date('1990-01-01')
    expect(
      isExpired({
        flagId: 'f',
        contactDob: dob,
        defaultDays: 365,
        createdAt: new Date('2020-01-01'),
        now: new Date('2016-01-02'), // 26y after DOB
      }),
    ).toBe(true)
  })
})
