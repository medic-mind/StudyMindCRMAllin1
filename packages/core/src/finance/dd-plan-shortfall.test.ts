// Pure classifier for Direct Debit plan shortfalls (ADR 0038, CLAUDE.md §6.3).
// Covers the case the defaulter engine misses: a fixed-length plan cancelled
// part-way through, leaving contracted instalments uncollected.

import { describe, expect, it } from 'vitest'

import {
  ARREARS_THRESHOLD,
  classifyActivePlanArrears,
  classifyPlanShortfall,
  expectedInstalmentsByNow,
  type ActivePlanFacts,
  type PlanFacts,
} from './dd-plan-shortfall'

function facts(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    gcSubscriptionId: 'SB123',
    name: 'GCSE Maths — 12 month plan',
    status: 'cancelled',
    amountMinor: 10_000, // £100 per instalment
    currency: 'GBP',
    totalPaymentCount: 12,
    gcCustomerId: 'CU1',
    startDate: new Date('2026-01-01'),
    endDate: new Date('2026-05-01'),
    gcCreatedAt: new Date('2025-12-20'),
    collectedCount: 4,
    collectedMinor: 40_000, // £400 collected
    lastCollectedAt: new Date('2026-04-01'),
    ...overrides,
  }
}

describe('classifyPlanShortfall', () => {
  it('flags a plan cancelled part-way with the contracted total and shortfall', () => {
    const row = classifyPlanShortfall(facts())
    expect(row).not.toBeNull()
    // £100 × 12 contracted, £400 collected → £800 still due, 8 missed.
    expect(row?.expectedTotalMinor).toBe(120_000)
    expect(row?.collectedMinor).toBe(40_000)
    expect(row?.shortfallMinor).toBe(80_000)
    expect(row?.missedCount).toBe(8)
    expect(row?.cancelledPartway).toBe(true)
    expect(row?.reasons).toEqual(
      expect.arrayContaining(['cancelled_partway', 'collection_shortfall']),
    )
  })

  it('ignores a plan that collected every instalment in full', () => {
    expect(
      classifyPlanShortfall(
        facts({ status: 'finished', collectedCount: 12, collectedMinor: 120_000 }),
      ),
    ).toBeNull()
  })

  it('ignores active plans — only ended plans are reconciled', () => {
    expect(classifyPlanShortfall(facts({ status: 'active' }))).toBeNull()
    expect(classifyPlanShortfall(facts({ status: 'paused' }))).toBeNull()
  })

  it('fails closed on open-ended plans with no contracted count', () => {
    expect(classifyPlanShortfall(facts({ totalPaymentCount: null }))).toBeNull()
    expect(classifyPlanShortfall(facts({ totalPaymentCount: 0 }))).toBeNull()
  })

  it('flags a finished plan that collected fewer instalments than contracted', () => {
    const row = classifyPlanShortfall(
      facts({ status: 'finished', collectedCount: 10, collectedMinor: 100_000 }),
    )
    expect(row?.reasons).toContain('finished_underpaid')
    expect(row?.cancelledPartway).toBe(false)
    expect(row?.shortfallMinor).toBe(20_000)
    expect(row?.missedCount).toBe(2)
  })

  it('never reports a negative shortfall when more was collected than contracted', () => {
    const row = classifyPlanShortfall(
      facts({ status: 'cancelled', collectedCount: 12, collectedMinor: 130_000 }),
    )
    // Collected all instalments (and then some) → healthy, no shortfall.
    expect(row).toBeNull()
  })

  it('flags a cancelled plan that collected its count but left value uncollected', () => {
    // Edge: count reached but a later instalment was a partial/zero collection.
    const row = classifyPlanShortfall(
      facts({ status: 'cancelled', collectedCount: 12, collectedMinor: 110_000 }),
    )
    expect(row?.reasons).toContain('collection_shortfall')
    expect(row?.reasons).not.toContain('cancelled_partway')
    expect(row?.shortfallMinor).toBe(10_000)
  })
})

describe('expectedInstalmentsByNow', () => {
  const start = new Date('2026-01-15T00:00:00Z')

  it('counts the first instalment from the start date', () => {
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'monthly', interval: 1, totalPaymentCount: null },
        start,
      ),
    ).toBe(1)
  })

  it('counts whole monthly cycles elapsed', () => {
    // 15 Jan → 20 Apr = 3 whole months → 4 instalments due.
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'monthly', interval: 1, totalPaymentCount: null },
        new Date('2026-04-20T00:00:00Z'),
      ),
    ).toBe(4)
  })

  it('respects the interval and the contracted cap', () => {
    // Every 3 months from Jan; by Dec = 11 months → 3 cycles → 4 due, capped at 3.
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'monthly', interval: 3, totalPaymentCount: 3 },
        new Date('2026-12-15T00:00:00Z'),
      ),
    ).toBe(3)
  })

  it('handles weekly cadence', () => {
    // 4 weeks after start → 4 cycles → 5 instalments due.
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'weekly', interval: 1, totalPaymentCount: null },
        new Date('2026-02-12T00:00:00Z'),
      ),
    ).toBe(5)
  })

  it('returns 0 before the plan starts and null on unknown cadence/no start', () => {
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'monthly', interval: 1, totalPaymentCount: null },
        new Date('2026-01-01T00:00:00Z'),
      ),
    ).toBe(0)
    expect(
      expectedInstalmentsByNow(
        { startDate: start, intervalUnit: 'fortnightly', interval: 1, totalPaymentCount: null },
        start,
      ),
    ).toBeNull()
    expect(
      expectedInstalmentsByNow(
        { startDate: null, intervalUnit: 'monthly', interval: 1, totalPaymentCount: null },
        start,
      ),
    ).toBeNull()
  })
})

describe('classifyActivePlanArrears', () => {
  const start = new Date('2026-01-15T00:00:00Z')
  const now = new Date('2026-06-20T00:00:00Z') // ~5 months in → 6 instalments due

  function activeFacts(overrides: Partial<ActivePlanFacts> = {}): ActivePlanFacts {
    return {
      gcSubscriptionId: 'SB1',
      name: 'Monthly tutoring',
      status: 'active',
      amountMinor: 10_000,
      currency: 'GBP',
      intervalUnit: 'monthly',
      interval: 1,
      totalPaymentCount: null,
      startDate: start,
      gcCustomerId: 'CU1',
      nextChargeAt: new Date('2026-07-15T00:00:00Z'),
      collectedCount: 6,
      collectedMinor: 60_000,
      lastCollectedAt: new Date('2026-06-15T00:00:00Z'),
      ...overrides,
    }
  }

  it('flags a plan two or more instalments behind schedule', () => {
    // 6 due, only 3 collected → 3 behind.
    const row = classifyActivePlanArrears(
      activeFacts({ collectedCount: 3, collectedMinor: 30_000 }),
      now,
    )
    expect(row).not.toBeNull()
    expect(row?.expectedByNow).toBe(6)
    expect(row?.missedCount).toBe(3)
    expect(row?.estimatedArrearsMinor).toBe(30_000)
  })

  it('does not flag a plan that is on schedule or only one behind', () => {
    expect(classifyActivePlanArrears(activeFacts({ collectedCount: 6 }), now)).toBeNull()
    expect(
      classifyActivePlanArrears(activeFacts({ collectedCount: 6 - (ARREARS_THRESHOLD - 1) }), now),
    ).toBeNull()
  })

  it('only considers active plans', () => {
    expect(
      classifyActivePlanArrears(activeFacts({ status: 'cancelled', collectedCount: 1 }), now),
    ).toBeNull()
  })

  it('never flags an open-ended plan with an unknown cadence', () => {
    expect(
      classifyActivePlanArrears(
        activeFacts({ intervalUnit: 'fortnightly', collectedCount: 0 }),
        now,
      ),
    ).toBeNull()
  })
})
