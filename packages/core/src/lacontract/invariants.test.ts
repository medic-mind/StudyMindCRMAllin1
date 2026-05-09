import { describe, expect, it } from 'vitest'

import { checkLaBilledFamilyHasNoCardSubscription } from './invariants'

describe('checkLaBilledFamilyHasNoCardSubscription', () => {
  it('returns ok for family-billed Families', () => {
    const r = checkLaBilledFamilyHasNoCardSubscription({
      billingParty: 'family',
      activeStripeSubscriptionIds: ['sub_1'],
      activeGcMandateIds: ['m_1'],
    })
    expect(r.ok).toBe(true)
  })

  it('returns ok for LA-billed Families with no card or mandate', () => {
    const r = checkLaBilledFamilyHasNoCardSubscription({
      billingParty: 'local_authority',
      activeStripeSubscriptionIds: [],
      activeGcMandateIds: [],
    })
    expect(r.ok).toBe(true)
  })

  it('flags violation for LA-billed Family with active Stripe sub', () => {
    const r = checkLaBilledFamilyHasNoCardSubscription({
      billingParty: 'local_authority',
      activeStripeSubscriptionIds: ['sub_1'],
      activeGcMandateIds: [],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.code).toBe('la_family_with_card_subscription')
      expect(r.details.activeStripeSubscriptionIds).toEqual(['sub_1'])
    }
  })

  it('flags violation for LA-billed Family with active GC mandate', () => {
    const r = checkLaBilledFamilyHasNoCardSubscription({
      billingParty: 'local_authority',
      activeStripeSubscriptionIds: [],
      activeGcMandateIds: ['m_1'],
    })
    expect(r.ok).toBe(false)
  })
})
