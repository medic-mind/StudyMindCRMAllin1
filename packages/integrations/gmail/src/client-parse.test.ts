import { describe, expect, it } from 'vitest'

import { customLabelNames, parseFromName } from './client'

describe('parseFromName', () => {
  it('extracts a plain display name', () => {
    expect(parseFromName('Mohil Shah <mohil@x.com>')).toBe('Mohil Shah')
  })
  it('extracts a quoted display name (with comma)', () => {
    expect(parseFromName('"Doe, John" <j@x.com>')).toBe('Doe, John')
  })
  it('returns null for a bare address', () => {
    expect(parseFromName('mohil@x.com')).toBeNull()
    expect(parseFromName('<mohil@x.com>')).toBeNull()
  })
  it('returns null for empty/missing', () => {
    expect(parseFromName(null)).toBeNull()
    expect(parseFromName('')).toBeNull()
  })
})

describe('customLabelNames', () => {
  const map = new Map([
    ['Label_7', 'Admissions'],
    ['Label_9', 'VIP'],
  ])
  it('keeps custom labels, drops system + category labels', () => {
    expect(
      customLabelNames(['INBOX', 'UNREAD', 'Label_7', 'CATEGORY_PROMOTIONS', 'Label_9'], map),
    ).toEqual(['Admissions', 'VIP'])
  })
  it('ignores unknown ids', () => {
    expect(customLabelNames(['Label_999'], map)).toEqual([])
  })
})
