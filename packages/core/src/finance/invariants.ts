// Finance domain invariants. Pure; CLAUDE.md §41.2.

export interface InvariantOk {
  ok: true
}
export interface InvariantFail {
  ok: false
  code: string
  message: string
}
export type InvariantResult = InvariantOk | InvariantFail

/**
 * §41.2: sum of Allocation.amount_minor for a Payment never exceeds
 * Payment.amount_minor.
 */
export function checkAllocationSumWithinPayment(input: {
  paymentAmountMinor: number
  allocationAmountsMinor: ReadonlyArray<number>
}): InvariantResult {
  const sum = input.allocationAmountsMinor.reduce((a, b) => a + b, 0)
  if (sum > input.paymentAmountMinor) {
    return {
      ok: false,
      code: 'OVER_ALLOCATED_PAYMENT',
      message: `Allocations sum to ${sum} but payment is only ${input.paymentAmountMinor}`,
    }
  }
  return { ok: true }
}

/**
 * §41.2: a RefundIntent cannot exceed the net captured amount on the
 * underlying Charge. Net = captured − sum(other refunds). Float-free.
 */
export function checkRefundWithinNetCaptured(input: {
  capturedMinor: number
  existingRefundsMinor: ReadonlyArray<number>
  proposedRefundMinor: number
}): InvariantResult {
  const refunded = input.existingRefundsMinor.reduce((a, b) => a + b, 0)
  const remaining = input.capturedMinor - refunded
  if (input.proposedRefundMinor > remaining) {
    return {
      ok: false,
      code: 'REFUND_EXCEEDS_NET_CAPTURED',
      message: `Proposed ${input.proposedRefundMinor} exceeds remaining ${remaining}`,
    }
  }
  if (input.proposedRefundMinor < 0) {
    return {
      ok: false,
      code: 'REFUND_NEGATIVE',
      message: 'Refund must be non-negative',
    }
  }
  return { ok: true }
}

/**
 * §41.2: a Family in state `churned` cannot have an active Stripe
 * subscription or an active GoCardless mandate.
 */
export function checkChurnedHasNoActiveBilling(input: {
  state: string
  hasActiveSubscription: boolean
  hasActiveMandate: boolean
}): InvariantResult {
  if (input.state !== 'churned') return { ok: true }
  if (input.hasActiveSubscription) {
    return {
      ok: false,
      code: 'CHURNED_WITH_ACTIVE_SUBSCRIPTION',
      message: 'A churned Family cannot have an active Stripe subscription',
    }
  }
  if (input.hasActiveMandate) {
    return {
      ok: false,
      code: 'CHURNED_WITH_ACTIVE_MANDATE',
      message: 'A churned Family cannot have an active GoCardless mandate',
    }
  }
  return { ok: true }
}

/**
 * §41.2: hours `delivered` for a BookingSession is monotonic; the only
 * permitted decrease is via a `correctedBy` link to a netting session.
 */
export function checkDeliveredHoursMonotonic(input: {
  previousDeliveredHours: number
  newDeliveredHours: number
  hasCorrectionLink: boolean
}): InvariantResult {
  if (
    input.newDeliveredHours < input.previousDeliveredHours &&
    !input.hasCorrectionLink
  ) {
    return {
      ok: false,
      code: 'DELIVERED_HOURS_NON_MONOTONIC',
      message:
        'delivered hours can only decrease via a correctedBy netting session',
    }
  }
  return { ok: true }
}

/**
 * §41.2: a `FinancialAccount` balance is derived, never stored. If a
 * caller asks us to validate a list of column names on the row, fail when
 * any matches `balance_minor` (case-insensitive).
 */
export function checkNoStoredBalanceColumn(
  columnNames: ReadonlyArray<string>,
): InvariantResult {
  const offender = columnNames.find(
    (c) => c.toLowerCase() === 'balance_minor' || c.toLowerCase() === 'balanceminor',
  )
  if (offender) {
    return {
      ok: false,
      code: 'STORED_BALANCE_FORBIDDEN',
      message: `FinancialAccount must not store balance: found '${offender}'`,
    }
  }
  return { ok: true }
}
