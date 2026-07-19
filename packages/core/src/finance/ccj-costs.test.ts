import { describe, expect, it } from 'vitest'

import {
  courtIssueFeeMinor,
  DEFAULT_DD_LATE_FEE_MINOR,
  estimateCcjCosts,
  resolveDdLateFeeMinor,
} from './ccj-costs'

describe('courtIssueFeeMinor (gov.uk EX50 money-claim issue scale)', () => {
  it('matches the published flat bands', () => {
    expect(courtIssueFeeMinor(20_000)).toBe(3_500) // £200 → £35
    expect(courtIssueFeeMinor(30_000)).toBe(3_500) // £300 (inclusive) → £35
    expect(courtIssueFeeMinor(30_001)).toBe(5_000) // £300.01 → £50
    expect(courtIssueFeeMinor(50_000)).toBe(5_000) // £500 → £50
    expect(courtIssueFeeMinor(100_000)).toBe(7_000) // £1,000 → £70
    expect(courtIssueFeeMinor(150_000)).toBe(8_000) // £1,500 → £80
    expect(courtIssueFeeMinor(300_000)).toBe(11_500) // £3,000 → £115
    expect(courtIssueFeeMinor(500_000)).toBe(20_500) // £5,000 → £205
    expect(courtIssueFeeMinor(1_000_000)).toBe(45_500) // £10,000 → £455
  })

  it('is 5% between £10k and £200k, capped at £10,000', () => {
    expect(courtIssueFeeMinor(2_000_000)).toBe(100_000) // £20,000 → 5% = £1,000
    expect(courtIssueFeeMinor(20_000_000)).toBe(1_000_000) // £200,000 → 5% = £10,000
    expect(courtIssueFeeMinor(50_000_000)).toBe(1_000_000) // over £200,000 → £10,000 cap
  })
})

describe('estimateCcjCosts', () => {
  const now = new Date('2026-08-01T00:00:00Z')

  it('accrues 8% simple interest from the overdue date', () => {
    // £1,000 principal, 365 days overdue → interest = £80.
    const e = estimateCcjCosts({
      outstandingMinor: 100_000,
      overdueSince: new Date('2025-08-01T00:00:00Z'),
      now,
      lateFeeMinor: 1_200,
    })
    expect(e.daysOverdue).toBe(365)
    expect(e.interestMinor).toBe(8_000) // £80.00
    // daily = £1000 * 0.08 / 365 ≈ £0.2192 → 22p rounded.
    expect(e.dailyInterestMinor).toBe(22)
    // court fee on (1000 + 80) = £1,080 → £80 band.
    expect(e.courtFeeMinor).toBe(8_000)
    // total = 1000 + 12 (late) + 80 (court) + 80 (interest) = £1,172.
    expect(e.totalMinor).toBe(100_000 + 1_200 + 8_000 + 8_000)
  })

  it('is zero-interest when there is no overdue date', () => {
    const e = estimateCcjCosts({ outstandingMinor: 50_000, now })
    expect(e.daysOverdue).toBe(0)
    expect(e.interestMinor).toBe(0)
    expect(e.courtFeeMinor).toBe(5_000) // £500 → £50
    expect(e.totalMinor).toBe(55_000)
  })
})

describe('resolveDdLateFeeMinor', () => {
  it('defaults and parses a pounds override', () => {
    expect(resolveDdLateFeeMinor(undefined)).toBe(DEFAULT_DD_LATE_FEE_MINOR)
    expect(resolveDdLateFeeMinor('20')).toBe(2_000)
    expect(resolveDdLateFeeMinor('bad')).toBe(DEFAULT_DD_LATE_FEE_MINOR)
  })
})
