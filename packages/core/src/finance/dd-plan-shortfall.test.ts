// Pure classifier for Direct Debit plan shortfalls (ADR 0038, CLAUDE.md §6.3).
// Covers the case the defaulter engine misses: a fixed-length plan cancelled
// part-way through, leaving contracted instalments uncollected.

import { describe, expect, it } from 'vitest'

import { classifyPlanShortfall, type PlanFacts } from './dd-plan-shortfall'

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
