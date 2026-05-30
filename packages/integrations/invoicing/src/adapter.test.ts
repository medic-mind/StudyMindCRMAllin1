// Adapter mapping tests (pure). Verifies the CRM → platform category routing
// and payload shaping documented in CLAUDE.md.

import { describe, expect, it } from 'vitest'

import {
  businessAccountToCustomerPayload,
  categoryForBusinessAccount,
  contactToCustomerPayload,
  lineItemToPayload,
  type CrmBusinessAccount,
  type CrmContact,
} from './adapter'

const school: CrmBusinessAccount = {
  kind: 'school',
  name: 'Oakwood Primary',
  contactEmail: 'office@oakwood.test',
  contactPhone: '+44 7000 000001',
  addressLine1: '1 High St',
  addressLine2: null,
  city: 'Leeds',
  postcode: 'LS1 1AA',
  country: 'United Kingdom',
  notes: 'SENCo is the main contact',
}

describe('categoryForBusinessAccount', () => {
  it('routes schools and partnerships to b2b', () => {
    expect(categoryForBusinessAccount({ kind: 'school' })).toBe('b2b')
    expect(categoryForBusinessAccount({ kind: 'partnership' })).toBe('b2b')
  })

  it('routes AP/council accounts to alt_provision', () => {
    expect(categoryForBusinessAccount({ kind: 'partnership', isAlternativeProvision: true })).toBe(
      'alt_provision',
    )
  })
})

describe('businessAccountToCustomerPayload', () => {
  it('maps a school to a b2b customer payload with a joined address', () => {
    const payload = businessAccountToCustomerPayload(school)
    expect(payload.company_name).toBe('Oakwood Primary')
    expect(payload.category).toBe('b2b')
    expect(payload.contact_email).toBe('office@oakwood.test')
    expect(payload.address).toBe('1 High St, Leeds, LS1 1AA')
    expect(payload.country).toBe('United Kingdom')
  })

  it('routes an AP-flagged account to alt_provision', () => {
    const payload = businessAccountToCustomerPayload({
      ...school,
      kind: 'partnership',
      isAlternativeProvision: true,
    })
    expect(payload.category).toBe('alt_provision')
  })
})

describe('contactToCustomerPayload', () => {
  it('maps a B2C contact to a b2c customer with the person name as company_name', () => {
    const contact: CrmContact = {
      firstName: 'Jamie',
      lastName: 'Doe',
      email: 'jamie@example.test',
      phoneE164: '+44 7000 000002',
      addressLine1: null,
      addressLine2: null,
      city: 'York',
      postcode: null,
      country: 'United Kingdom',
    }
    const payload = contactToCustomerPayload(contact)
    expect(payload.category).toBe('b2c')
    expect(payload.company_name).toBe('Jamie Doe')
    expect(payload.contact_name).toBe('Jamie Doe')
    expect(payload.contact_email).toBe('jamie@example.test')
    expect(payload.address).toBe('York')
  })

  it('falls back to email when no name is set', () => {
    const payload = contactToCustomerPayload({
      firstName: null,
      lastName: null,
      email: 'noname@example.test',
      phoneE164: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      postcode: null,
      country: null,
    })
    expect(payload.company_name).toBe('noname@example.test')
  })
})

describe('lineItemToPayload', () => {
  it('converts minor units to major and preserves quantity + vat', () => {
    const payload = lineItemToPayload({
      description: 'UCAT tutoring — 10 sessions',
      quantity: 10,
      unitPriceMinor: 5000,
      vatRate: 20,
    })
    expect(payload).toEqual({
      description: 'UCAT tutoring — 10 sessions',
      quantity: 10,
      unit_price: 50,
      vat_rate: 20,
    })
  })

  it('omits vat_rate when not provided', () => {
    const payload = lineItemToPayload({
      description: 'Course materials',
      quantity: 1,
      unitPriceMinor: 10000,
    })
    expect(payload).toEqual({
      description: 'Course materials',
      quantity: 1,
      unit_price: 100,
    })
    expect('vat_rate' in payload).toBe(false)
  })
})
