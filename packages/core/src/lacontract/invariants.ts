// LAContract / LA-billed Family invariants. CLAUDE.md §43.2, §41.2.
//
// Pure helpers — no I/O. The reconciliation engine consumes these to surface
// `la_family_with_card_subscription` discrepancies.

export interface LaInvariantInput {
  billingParty: 'family' | 'local_authority'
  activeStripeSubscriptionIds: ReadonlyArray<string>
  activeGcMandateIds: ReadonlyArray<string>
}

export interface LaInvariantViolation {
  ok: false
  code: 'la_family_with_card_subscription'
  details: {
    activeStripeSubscriptionIds: string[]
    activeGcMandateIds: string[]
  }
}

export interface LaInvariantOk {
  ok: true
}

/**
 * A Family with billingParty='local_authority' must not carry an active
 * Stripe subscription or active GoCardless mandate. Returns a typed
 * violation so the reconciliation engine can build a discrepancy with the
 * offending IDs.
 */
export function checkLaBilledFamilyHasNoCardSubscription(
  input: LaInvariantInput,
): LaInvariantViolation | LaInvariantOk {
  if (input.billingParty !== 'local_authority') return { ok: true }
  if (input.activeStripeSubscriptionIds.length === 0 && input.activeGcMandateIds.length === 0) {
    return { ok: true }
  }
  return {
    ok: false,
    code: 'la_family_with_card_subscription',
    details: {
      activeStripeSubscriptionIds: [...input.activeStripeSubscriptionIds],
      activeGcMandateIds: [...input.activeGcMandateIds],
    },
  }
}
