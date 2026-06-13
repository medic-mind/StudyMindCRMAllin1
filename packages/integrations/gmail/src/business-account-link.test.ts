import { describe, expect, it } from 'vitest'

import { firstAccountByContact } from './business-account-link'

describe('firstAccountByContact', () => {
  it('maps each contact to its first-seen account', () => {
    const map = firstAccountByContact([
      { contactId: 'c1', accountId: 'a1' },
      { contactId: 'c2', accountId: 'a2' },
    ])
    expect(map.get('c1')).toBe('a1')
    expect(map.get('c2')).toBe('a2')
  })

  it('keeps the first account when a contact belongs to several (deterministic)', () => {
    const map = firstAccountByContact([
      { contactId: 'c1', accountId: 'a1' },
      { contactId: 'c1', accountId: 'a2' },
    ])
    expect(map.get('c1')).toBe('a1')
  })

  it('omits contacts with no account link', () => {
    const map = firstAccountByContact([{ contactId: 'c1', accountId: 'a1' }])
    expect(map.has('c2')).toBe(false)
    expect(map.get('c2')).toBeUndefined()
  })

  it('empty input yields an empty map', () => {
    expect(firstAccountByContact([]).size).toBe(0)
  })
})
