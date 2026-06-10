// Status mappers fail closed on unknown provider values (CLAUDE.md §8).

import { describe, expect, it } from 'vitest'

import { mapMandateStatus, mapPaymentStatus, mapSubscriptionStatus } from './types'

describe('mapSubscriptionStatus', () => {
  it('maps every documented status verbatim', () => {
    for (const status of [
      'pending_customer_approval',
      'customer_approval_denied',
      'active',
      'finished',
      'cancelled',
      'paused',
    ]) {
      expect(mapSubscriptionStatus(status)).toBe(status)
    }
  })

  it('fails closed on unknown / missing values', () => {
    expect(mapSubscriptionStatus('brand_new_status')).toBe('unknown')
    expect(mapSubscriptionStatus(null)).toBe('unknown')
    expect(mapSubscriptionStatus(undefined)).toBe('unknown')
  })
})

describe('existing mappers stay fail-closed', () => {
  it('payment + mandate mappers reject unknowns', () => {
    expect(mapPaymentStatus('weird')).toBe('unknown')
    expect(mapMandateStatus('weird')).toBe('unknown')
  })
})
