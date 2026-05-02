// Validation tests for the Contact zod schemas.

import { describe, expect, it } from 'vitest'

import { ContactCreateInput, E164, Email, displayNameOf, isMinorByDob } from './types.js'

describe('E164', () => {
  it('accepts a UK mobile number', () => {
    expect(E164.safeParse('+447700900123').success).toBe(true)
  })

  it('accepts an international number', () => {
    expect(E164.safeParse('+12025550123').success).toBe(true)
  })

  it.each(['07700900123', '+0123456', '+447700900123x', 'not-a-number', ''])(
    'rejects %p',
    (bad) => {
      expect(E164.safeParse(bad).success).toBe(false)
    },
  )
})

describe('Email', () => {
  it('accepts a normal address', () => {
    expect(Email.safeParse('alex@studymind.co.uk').success).toBe(true)
  })

  it('rejects malformed addresses', () => {
    expect(Email.safeParse('not-an-email').success).toBe(false)
    expect(Email.safeParse('@studymind.co.uk').success).toBe(false)
  })
})

describe('ContactCreateInput', () => {
  it('accepts a minimal payload', () => {
    const r = ContactCreateInput.safeParse({ kind: 'parent' })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    const r = ContactCreateInput.safeParse({ kind: 'admin' })
    expect(r.success).toBe(false)
  })

  it('rejects a phone that is not E.164', () => {
    const r = ContactCreateInput.safeParse({ kind: 'parent', phoneE164: '07700900123' })
    expect(r.success).toBe(false)
  })
})

describe('displayNameOf', () => {
  it('prefers full name', () => {
    expect(displayNameOf({ firstName: 'Alex', lastName: 'Doe', email: 'a@b.com' })).toBe('Alex Doe')
  })

  it('falls back to email then to placeholder', () => {
    expect(displayNameOf({ email: 'a@b.com' })).toBe('a@b.com')
    expect(displayNameOf({})).toBe('Unnamed contact')
  })
})

describe('isMinorByDob', () => {
  const now = new Date('2026-05-02T00:00:00Z')

  it('returns true for a 12-year-old', () => {
    expect(isMinorByDob(new Date('2014-01-01T00:00:00Z'), now)).toBe(true)
  })

  it('returns false for a 30-year-old', () => {
    expect(isMinorByDob(new Date('1995-06-01T00:00:00Z'), now)).toBe(false)
  })

  it('returns false for missing dob', () => {
    expect(isMinorByDob(null, now)).toBe(false)
  })
})
