import { describe, expect, it } from 'vitest'

import { clusterDuplicates, emailKey, phoneKey } from './duplicates'

describe('emailKey / phoneKey', () => {
  it('normalises email and the phone suffix', () => {
    expect(emailKey(' Parent@Example.COM ')).toBe('parent@example.com')
    expect(emailKey('')).toBeNull()
    expect(phoneKey('+447700900111')).toBe('700900111')
    expect(phoneKey('07700900111')).toBe('700900111')
    expect(phoneKey('123')).toBeNull()
  })
})

describe('clusterDuplicates', () => {
  it('groups contacts sharing an email', () => {
    const groups = clusterDuplicates([
      { id: 'a', email: 'jo@x.com', phoneE164: null },
      { id: 'b', email: 'JO@x.com', phoneE164: null },
      { id: 'c', email: 'other@x.com', phoneE164: null },
    ])
    expect(groups).toEqual([['a', 'b']])
  })

  it('groups contacts sharing a phone across formats', () => {
    const groups = clusterDuplicates([
      { id: 'a', email: null, phoneE164: '+447700900111' },
      { id: 'b', email: null, phoneE164: '07700900111' },
    ])
    expect(groups).toEqual([['a', 'b']])
  })

  it('is transitive: email link + phone link merge into one cluster', () => {
    const groups = clusterDuplicates([
      { id: 'a', email: 'jo@x.com', phoneE164: '+447700900111' },
      { id: 'b', email: 'jo@x.com', phoneE164: null }, // email-links to a
      { id: 'c', email: null, phoneE164: '07700900111' }, // phone-links to a
    ])
    expect(groups).toHaveLength(1)
    expect(new Set(groups[0])).toEqual(new Set(['a', 'b', 'c']))
  })

  it('preserves input order (oldest-first survivor default)', () => {
    const groups = clusterDuplicates([
      { id: 'old', email: 'jo@x.com', phoneE164: null },
      { id: 'new', email: 'jo@x.com', phoneE164: null },
    ])
    expect(groups[0]).toEqual(['old', 'new'])
  })

  it('omits singletons', () => {
    expect(
      clusterDuplicates([
        { id: 'a', email: 'a@x.com', phoneE164: null },
        { id: 'b', email: 'b@x.com', phoneE164: null },
      ]),
    ).toEqual([])
  })
})
