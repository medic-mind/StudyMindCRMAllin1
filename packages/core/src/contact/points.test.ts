import { describe, expect, it } from 'vitest'

import {
  ContactPointCreateInput,
  normaliseContactPointValue,
} from './points'

describe('normaliseContactPointValue', () => {
  it('lowercases + trims an email', () => {
    expect(normaliseContactPointValue('email', '  John.Smith@Example.COM ')).toBe(
      'john.smith@example.com',
    )
  })
  it('trims but preserves case for phone / other', () => {
    expect(normaliseContactPointValue('phone', ' +447700900123 ')).toBe('+447700900123')
    expect(normaliseContactPointValue('other', '  @studymind_ig ')).toBe('@studymind_ig')
  })
})

describe('ContactPointCreateInput', () => {
  it('accepts a valid email point', () => {
    expect(
      ContactPointCreateInput.safeParse({
        contactId: 'c1',
        kind: 'email',
        value: 'a@b.com',
        label: 'Work',
      }).success,
    ).toBe(true)
  })
  it('rejects a malformed email', () => {
    expect(
      ContactPointCreateInput.safeParse({ contactId: 'c1', kind: 'email', value: 'not-an-email' })
        .success,
    ).toBe(false)
  })
  it('accepts a phone or other value without email validation', () => {
    expect(
      ContactPointCreateInput.safeParse({ contactId: 'c1', kind: 'phone', value: '+447700900123' })
        .success,
    ).toBe(true)
    expect(
      ContactPointCreateInput.safeParse({ contactId: 'c1', kind: 'other', value: 'WhatsApp: 07…' })
        .success,
    ).toBe(true)
  })
})
