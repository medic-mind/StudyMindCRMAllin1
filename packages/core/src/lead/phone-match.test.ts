import { describe, expect, it } from 'vitest'

import { buildPhoneMatch } from './phone-match'

describe('buildPhoneMatch', () => {
  it('dedupes the candidate forms and drops blanks', () => {
    const q = buildPhoneMatch(['+447700900111', '+447700900111', null, '', undefined])
    expect(q.exact).toEqual(['+447700900111'])
  })

  it('derives the last-9 suffix so national and E.164 forms converge', () => {
    // The dedupe bug: stored "928812118", re-enquiry composes "+51928812118".
    expect(buildPhoneMatch(['928812118']).suffix).toBe('928812118')
    expect(buildPhoneMatch(['+51928812118']).suffix).toBe('928812118')
    expect(buildPhoneMatch(['+447700900111']).suffix).toBe('700900111')
  })

  it('returns a null suffix when nothing has enough digits', () => {
    expect(buildPhoneMatch(['123', null]).suffix).toBeNull()
    expect(buildPhoneMatch([]).suffix).toBeNull()
  })

  it('takes the suffix from the first form with ≥9 digits', () => {
    const q = buildPhoneMatch(['123', '+447700900111'])
    expect(q.suffix).toBe('700900111')
    expect(q.exact).toEqual(['123', '+447700900111'])
  })
})
