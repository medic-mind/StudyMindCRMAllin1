import { describe, expect, it } from 'vitest'

import { clusterDuplicates, emailKey, nameKey, phoneKey, planAutoMerges } from './duplicates'

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

describe('nameKey', () => {
  it('normalises to lowercase alphanumerics + single spaces', () => {
    expect(nameKey('  John   Smith ')).toBe('john smith')
    expect(nameKey('JOHN-SMITH')).toBe('john smith')
    expect(nameKey('  ')).toBeNull()
    expect(nameKey(null)).toBeNull()
  })
})

describe('planAutoMerges', () => {
  it('auto-merges contacts sharing an email (oldest survives)', () => {
    const plans = planAutoMerges([
      { id: 'old', email: 'jo@x.com', phoneE164: null, name: 'Jo' },
      { id: 'new', email: 'JO@x.com', phoneE164: null, name: 'Jo Bloggs' },
    ])
    expect(plans).toEqual([{ survivorId: 'old', loserIds: ['new'] }])
  })

  it('auto-merges a phone match ONLY when the name also matches', () => {
    const plans = planAutoMerges([
      { id: 'a', email: null, phoneE164: '+447700900111', name: 'Jane Doe' },
      { id: 'b', email: null, phoneE164: '07700900111', name: 'Jane Doe' },
    ])
    expect(plans).toEqual([{ survivorId: 'a', loserIds: ['b'] }])
  })

  it('does NOT auto-merge a shared landline with different names (§41.1)', () => {
    // Same phone, different people (a family landline) — left for manual review.
    const plans = planAutoMerges([
      { id: 'mum', email: null, phoneE164: '+447700900111', name: 'Jane Doe' },
      { id: 'son', email: null, phoneE164: '07700900111', name: 'Tom Doe' },
    ])
    expect(plans).toEqual([])
  })

  it('keeps only the survivor-connected members, dropping the ambiguous tail', () => {
    // old~new share an email (confident); landline only shares a phone with a
    // different name, so it is excluded from the auto-merge and stays manual.
    const plans = planAutoMerges([
      { id: 'old', email: 'jo@x.com', phoneE164: '+447700900111', name: 'Jo Bloggs' },
      { id: 'new', email: 'jo@x.com', phoneE164: null, name: 'Jo Bloggs' },
      { id: 'landline', email: null, phoneE164: '07700900111', name: 'Other Person' },
    ])
    expect(plans).toEqual([{ survivorId: 'old', loserIds: ['new'] }])
  })

  it('returns nothing when there are no duplicates', () => {
    expect(
      planAutoMerges([
        { id: 'a', email: 'a@x.com', phoneE164: null, name: 'A' },
        { id: 'b', email: 'b@x.com', phoneE164: null, name: 'B' },
      ]),
    ).toEqual([])
  })
})
