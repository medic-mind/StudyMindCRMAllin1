import { describe, expect, it } from 'vitest'

import { complaintCustomer } from './customer'

const contact = {
  id: 'c1',
  firstName: 'Aanya',
  lastName: 'Sharma',
  email: 'aanya@example.com',
  phoneE164: '+447700900001',
}

describe('complaintCustomer', () => {
  it('uses the linked CRM contact when present', () => {
    const r = complaintCustomer({ contact, personName: null, personPhone: null, personEmail: null })
    expect(r).toEqual({
      contactId: 'c1',
      name: 'Aanya Sharma',
      phone: '+447700900001',
      email: 'aanya@example.com',
      manual: false,
    })
  })

  it('falls back to the contact email when it has no name', () => {
    const r = complaintCustomer({
      contact: { ...contact, firstName: null, lastName: null },
      personName: null,
      personPhone: null,
      personEmail: null,
    })
    expect(r.name).toBe('aanya@example.com')
    expect(r.manual).toBe(false)
  })

  it('uses the manual person when there is no CRM contact', () => {
    const r = complaintCustomer({
      contact: null,
      personName: 'John Doe',
      personPhone: '07123 456789',
      personEmail: 'john@doe.com',
    })
    expect(r).toEqual({
      contactId: null,
      name: 'John Doe',
      phone: '07123 456789',
      email: 'john@doe.com',
      manual: true,
    })
  })

  it('falls back to phone/email then a placeholder for a nameless manual complaint', () => {
    expect(
      complaintCustomer({ contact: null, personName: '  ', personPhone: '07999', personEmail: null })
        .name,
    ).toBe('07999')
    expect(
      complaintCustomer({ contact: null, personName: null, personPhone: null, personEmail: null })
        .name,
    ).toBe('Manual customer')
  })
})
