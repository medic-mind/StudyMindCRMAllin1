import { describe, expect, it } from 'vitest'

import { normaliseMediAccount } from './types'

const base = {
  event: 'user.registered',
  user: {
    id: 'usr_123',
    email: 'Jordan.Smith@Example.com',
    name: 'Jordan Smith',
    role: 'Student',
    phone: '+44 7700 900123',
    phone_country: 'GB',
    country: 'United Kingdom',
  },
  contact: null,
  signup_ip: '203.0.113.7',
  user_agent: 'jest',
}

describe('normaliseMediAccount', () => {
  it('normalises a full account payload', () => {
    const out = normaliseMediAccount(base)
    expect(out).not.toBeNull()
    expect(out!.event).toBe('user.registered')
    expect(out!.mediUserId).toBe('usr_123')
    expect(out!.role).toBe('student')
    expect(out!.country).toBe('United Kingdom')
    expect(out!.account).toEqual({
      firstName: 'Jordan',
      lastName: 'Smith',
      email: 'jordan.smith@example.com',
      phoneE164: '+447700900123',
    })
    expect(out!.related).toBeNull()
  })

  it('coerces a numeric user id to a string', () => {
    const out = normaliseMediAccount({ ...base, user: { ...base.user, id: 42 } })
    expect(out!.mediUserId).toBe('42')
  })

  it('defaults the event when the portal omits it', () => {
    const out = normaliseMediAccount({ ...base, event: undefined })
    expect(out!.event).toBe('user.registered')
  })

  it('prepends + to a bare phone and strips a 00 international prefix', () => {
    expect(normaliseMediAccount({ ...base, user: { ...base.user, phone: '447700900123' } })!.account.phoneE164).toBe(
      '+447700900123',
    )
    expect(normaliseMediAccount({ ...base, user: { ...base.user, phone: '0044 7700 900123' } })!.account.phoneE164).toBe(
      '+447700900123',
    )
  })

  it('drops a phone that is too short to be real', () => {
    const out = normaliseMediAccount({ ...base, user: { ...base.user, phone: '123' } })
    expect(out!.account.phoneE164).toBeNull()
    // email still keys the contact, so the payload is accepted
    expect(out).not.toBeNull()
  })

  it('splits a single-word name into first only', () => {
    const out = normaliseMediAccount({ ...base, user: { ...base.user, name: 'Cher' } })
    expect(out!.account.firstName).toBe('Cher')
    expect(out!.account.lastName).toBeNull()
  })

  it('accepts an account with a phone but no email', () => {
    const out = normaliseMediAccount({
      ...base,
      user: { ...base.user, email: 'not-an-email', phone: '+447700900999' },
    })
    expect(out).not.toBeNull()
    expect(out!.account.email).toBeNull()
    expect(out!.account.phoneE164).toBe('+447700900999')
  })

  it('returns null when there is nothing to key on', () => {
    expect(
      normaliseMediAccount({ ...base, user: { ...base.user, email: 'bad', phone: null } }),
    ).toBeNull()
  })

  it('returns null for a payload with no user', () => {
    expect(normaliseMediAccount({ event: 'user.registered' })).toBeNull()
    expect(normaliseMediAccount(null)).toBeNull()
    expect(normaliseMediAccount('nope')).toBeNull()
  })

  it('parses a related parent contact with its relation', () => {
    const out = normaliseMediAccount({
      ...base,
      contact: {
        relation: 'parent_of_student',
        name: 'Robin Smith',
        email: 'ROBIN@example.com',
        phone: '+44 7700 900456',
        phone_country: 'GB',
      },
    })
    expect(out!.related).toEqual({
      firstName: 'Robin',
      lastName: 'Smith',
      email: 'robin@example.com',
      phoneE164: '+447700900456',
      relation: 'parent_of_student',
    })
  })

  it('ignores a related contact with neither email nor phone', () => {
    const out = normaliseMediAccount({
      ...base,
      contact: { relation: 'parent_of_student', name: 'No Contact Details' },
    })
    expect(out!.related).toBeNull()
  })
})
