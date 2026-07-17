import { describe, expect, it } from 'vitest'

import { phoneSearchDigitRuns } from './phone-search'

describe('phoneSearchDigitRuns', () => {
  it('tolerates spaces, dashes, dots and parens', () => {
    expect(phoneSearchDigitRuns('07818 953024')).toEqual(['07818953024', '7818953024'])
    expect(phoneSearchDigitRuns('(07818) 953-024')).toEqual(['07818953024', '7818953024'])
    expect(phoneSearchDigitRuns('07818.953.024')).toEqual(['07818953024', '7818953024'])
  })

  it('handles a typed country code with or without +', () => {
    expect(phoneSearchDigitRuns('+44 7818 953024')).toEqual(['447818953024', '7818953024'])
    expect(phoneSearchDigitRuns('44 7818 953024')).toEqual(['447818953024', '7818953024'])
    expect(phoneSearchDigitRuns('0044 7818 953024')).toEqual([
      '00447818953024',
      '447818953024',
      '7818953024',
    ])
  })

  it('handles the malformed +44 0… form the team pastes from Slack', () => {
    expect(phoneSearchDigitRuns('+44 07818 953024')).toEqual([
      '4407818953024',
      '7818953024',
    ])
  })

  it('supports partial numbers so a prefix finds the contact', () => {
    expect(phoneSearchDigitRuns('07818 953')).toEqual(['07818953', '7818953'])
    expect(phoneSearchDigitRuns('78189')).toEqual(['78189'])
  })

  it('keeps non-UK international numbers searchable without their +', () => {
    expect(phoneSearchDigitRuns('+39 331 158 5415')).toEqual(['393311585415'])
  })

  it('rejects non-phone queries', () => {
    expect(phoneSearchDigitRuns('Aviral Sethi')).toEqual([])
    expect(phoneSearchDigitRuns('jane@x.com')).toEqual([])
    expect(phoneSearchDigitRuns('2024')).toEqual([]) // too short — a year
    expect(phoneSearchDigitRuns('12345678901234567890123')).toEqual([]) // absurdly long
    expect(phoneSearchDigitRuns('Jo 07818')).toEqual([]) // mixed letters + digits
  })
})
