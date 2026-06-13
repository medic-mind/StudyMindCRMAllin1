// Tests for the Trengo team-mirror row normaliser (the sync itself is DB I/O,
// exercised against staging). Pins the field-shape folding across Trengo's
// /users response variants.

import { describe, expect, it } from 'vitest'

import { normaliseTrengoUser } from './team'

describe('normaliseTrengoUser', () => {
  it('prefers full_name, then name, then first+last', () => {
    expect(normaliseTrengoUser({ id: 1, full_name: 'Hamzah Khan' })?.name).toBe('Hamzah Khan')
    expect(normaliseTrengoUser({ id: 2, name: 'Ops Bot' })?.name).toBe('Ops Bot')
    expect(
      normaliseTrengoUser({ id: 3, first_name: 'Aisha', last_name: 'Begum' })?.name,
    ).toBe('Aisha Begum')
  })

  it('lowercases the email', () => {
    expect(normaliseTrengoUser({ id: 4, email: 'Agent@Studymind.CO.uk' })?.email).toBe(
      'agent@studymind.co.uk',
    )
  })

  it('defaults active, honours explicit inactivity', () => {
    expect(normaliseTrengoUser({ id: 5 })?.isActive).toBe(true)
    expect(normaliseTrengoUser({ id: 6, is_active: false })?.isActive).toBe(false)
    expect(normaliseTrengoUser({ id: 7, status: 'inactive' })?.isActive).toBe(false)
  })

  it('requires a numeric id', () => {
    expect(normaliseTrengoUser({ name: 'No Id' })).toBeNull()
    expect(normaliseTrengoUser(null)).toBeNull()
    expect(normaliseTrengoUser('x')).toBeNull()
  })

  it('returns null name + email when neither present', () => {
    const u = normaliseTrengoUser({ id: 8 })
    expect(u).toEqual({ trengoUserId: 8, name: null, email: null, isActive: true })
  })
})
