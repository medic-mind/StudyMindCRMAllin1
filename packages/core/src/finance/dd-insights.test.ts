// Pure money maths for the Direct Debit master dashboard (ADR 0038).

import { describe, expect, it } from 'vitest'

import { monthlyEquivalentMinor, monthlyRunRateMinor } from './dd-insights'

describe('monthlyEquivalentMinor', () => {
  it('weekly plans annualise then divide by 12', () => {
    // £30/week → £130/month
    expect(monthlyEquivalentMinor({ amountMinor: 3000, intervalUnit: 'weekly', interval: 1 })).toBe(
      13000,
    )
  })

  it('monthly plans pass through, divided by the interval', () => {
    expect(
      monthlyEquivalentMinor({ amountMinor: 4000, intervalUnit: 'monthly', interval: 1 }),
    ).toBe(4000)
    // £90 every 3 months → £30/month
    expect(
      monthlyEquivalentMinor({ amountMinor: 9000, intervalUnit: 'monthly', interval: 3 }),
    ).toBe(3000)
  })

  it('yearly plans divide by 12', () => {
    expect(
      monthlyEquivalentMinor({ amountMinor: 120_000, intervalUnit: 'yearly', interval: 1 }),
    ).toBe(10_000)
  })

  it('fails closed on unknown units and bad intervals', () => {
    expect(
      monthlyEquivalentMinor({ amountMinor: 4000, intervalUnit: 'fortnightly', interval: 1 }),
    ).toBe(0)
    expect(
      monthlyEquivalentMinor({ amountMinor: 4000, intervalUnit: 'monthly', interval: 0 }),
    ).toBe(4000)
  })
})

describe('monthlyRunRateMinor', () => {
  it('sums mixed cadences', () => {
    expect(
      monthlyRunRateMinor([
        { amountMinor: 3000, intervalUnit: 'weekly', interval: 1 }, // 13000
        { amountMinor: 4000, intervalUnit: 'monthly', interval: 1 }, // 4000
        { amountMinor: 120_000, intervalUnit: 'yearly', interval: 1 }, // 10000
      ]),
    ).toBe(27_000)
  })
})
