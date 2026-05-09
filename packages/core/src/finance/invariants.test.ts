// §41.2 Finance invariants — property-based tests.

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  checkAllocationSumWithinPayment,
  checkChurnedHasNoActiveBilling,
  checkDeliveredHoursMonotonic,
  checkNoStoredBalanceColumn,
  checkRefundWithinNetCaptured,
} from './invariants'

const SEED = 1714867200000

describe('§41.2 Finance invariants — property-based', () => {
  it('checkAllocationSumWithinPayment: sum > amount fails, ≤ passes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_00 }),
        fc.array(fc.integer({ min: 0, max: 50_000 }), { maxLength: 8 }),
        (paymentAmountMinor, allocationAmountsMinor) => {
          const sum = allocationAmountsMinor.reduce((a, b) => a + b, 0)
          const r = checkAllocationSumWithinPayment({
            paymentAmountMinor,
            allocationAmountsMinor,
          })
          expect(r.ok).toBe(sum <= paymentAmountMinor)
        },
      ),
      { seed: SEED, numRuns: 300 },
    )
  })

  it('checkRefundWithinNetCaptured: never exceeds remaining', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 5 }),
        fc.integer({ min: 0, max: 100_000 }),
        (capturedMinor, existingRefundsMinor, proposedRefundMinor) => {
          const refunded = existingRefundsMinor.reduce((a, b) => a + b, 0)
          const remaining = capturedMinor - refunded
          const r = checkRefundWithinNetCaptured({
            capturedMinor,
            existingRefundsMinor,
            proposedRefundMinor,
          })
          expect(r.ok).toBe(proposedRefundMinor <= remaining)
        },
      ),
      { seed: SEED, numRuns: 300 },
    )
  })

  it('checkRefundWithinNetCaptured: rejects negatives', () => {
    const r = checkRefundWithinNetCaptured({
      capturedMinor: 1000,
      existingRefundsMinor: [],
      proposedRefundMinor: -1,
    })
    expect(r.ok).toBe(false)
  })

  it('checkChurnedHasNoActiveBilling: only active billing fails for churned', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('lead', 'trial', 'active', 'at_risk', 'churned'),
        fc.boolean(),
        fc.boolean(),
        (state, hasSub, hasMandate) => {
          const r = checkChurnedHasNoActiveBilling({
            state,
            hasActiveSubscription: hasSub,
            hasActiveMandate: hasMandate,
          })
          if (state !== 'churned') {
            expect(r.ok).toBe(true)
          } else {
            expect(r.ok).toBe(!hasSub && !hasMandate)
          }
        },
      ),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkDeliveredHoursMonotonic: decrease without correction fails', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        fc.boolean(),
        (prev, next, hasCorrection) => {
          const r = checkDeliveredHoursMonotonic({
            previousDeliveredHours: prev,
            newDeliveredHours: next,
            hasCorrectionLink: hasCorrection,
          })
          if (next >= prev) expect(r.ok).toBe(true)
          else expect(r.ok).toBe(hasCorrection)
        },
      ),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkNoStoredBalanceColumn: any balance_minor variant trips it', () => {
    expect(
      checkNoStoredBalanceColumn(['id', 'familyId', 'balance_minor']).ok,
    ).toBe(false)
    expect(checkNoStoredBalanceColumn(['id', 'BalanceMinor']).ok).toBe(false)
    expect(checkNoStoredBalanceColumn(['id', 'familyId', 'status']).ok).toBe(true)
  })
})
