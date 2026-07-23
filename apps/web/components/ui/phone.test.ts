import { describe, expect, it } from 'vitest'

import {
  composePhone,
  DIAL,
  filterPhoneCountries,
  orderedPhoneCountries,
  parsePhone,
  PHONE_COUNTRIES,
  PINNED_DIAL_ISOS,
} from './phone'

describe('composePhone', () => {
  it('builds GB E.164 and strips the national trunk 0', () => {
    expect(composePhone('gb', '07700 900123')).toBe('+447700900123')
    expect(composePhone('gb', '7700900123')).toBe('+447700900123')
  })

  it('builds US E.164', () => {
    expect(composePhone('us', '202 555 0123')).toBe('+12025550123')
  })

  it('returns empty for a blank number (an empty phone field)', () => {
    expect(composePhone('gb', '')).toBe('')
    expect(composePhone('gb', '   ')).toBe('')
  })
})

describe('parsePhone', () => {
  it('splits +44 into GB + the national part', () => {
    expect(parsePhone('+447700900123')).toEqual({ iso: 'gb', national: '7700900123' })
  })

  it('splits +1 into US + the national part', () => {
    expect(parsePhone('+12025550123')).toEqual({ iso: 'us', national: '2025550123' })
  })

  it('defaults to GB for empty input', () => {
    expect(parsePhone('').iso).toBe('gb')
    expect(parsePhone(null).iso).toBe('gb')
  })

  it('treats a no-plus value as a local number under the default country', () => {
    expect(parsePhone('07700900123')).toEqual({ iso: 'gb', national: '07700900123' })
  })
})

describe('parse → compose round-trip preserves the stored E.164', () => {
  it.each(['+447700900123', '+12025550123', '+33612345678', '+353871234567'])(
    '%s',
    (e164) => {
      const p = parsePhone(e164)
      expect(composePhone(p.iso, p.national)).toBe(e164)
    },
  )
})

describe('dial-code data sanity', () => {
  it('has the common codes right', () => {
    expect(DIAL['gb']).toBe('44')
    expect(DIAL['us']).toBe('1')
    expect(DIAL['ie']).toBe('353')
    expect(DIAL['fr']).toBe('33')
    expect(DIAL['de']).toBe('49')
    expect(DIAL['in']).toBe('91')
    expect(DIAL['au']).toBe('61')
  })
})

describe('filterPhoneCountries', () => {
  it('returns the full list for an empty query', () => {
    expect(filterPhoneCountries('')).toHaveLength(PHONE_COUNTRIES.length)
    expect(filterPhoneCountries('   ')).toHaveLength(PHONE_COUNTRIES.length)
  })

  it('filters by dialling code — codes starting with the digits come first', () => {
    const codes = filterPhoneCountries('3').map((c) => c.dial)
    expect(codes.length).toBeGreaterThan(0)
    // Every result starts-with OR contains "3"; the leading run all start with 3.
    expect(codes[0]!.startsWith('3')).toBe(true)
    expect(filterPhoneCountries('3').every((c) => c.dial.includes('3'))).toBe(true)
  })

  it('a "+44"/"44" query surfaces the UK', () => {
    expect(filterPhoneCountries('44').some((c) => c.code === 'gb')).toBe(true)
    expect(filterPhoneCountries('+44').some((c) => c.code === 'gb')).toBe(true)
    // GB's dial code is exactly 44, so it ranks in the start-with group.
    expect(filterPhoneCountries('44')[0]!.dial.startsWith('44')).toBe(true)
  })

  it('filters by country name (case-insensitive, prefix first)', () => {
    const fr = filterPhoneCountries('fra')
    expect(fr[0]?.code).toBe('fr')
    expect(filterPhoneCountries('united').some((c) => c.code === 'gb')).toBe(true)
    expect(filterPhoneCountries('UNITED').some((c) => c.code === 'us')).toBe(true)
  })

  it('returns nothing for a nonsense query', () => {
    expect(filterPhoneCountries('zzzzz')).toHaveLength(0)
  })
})

describe('orderedPhoneCountries', () => {
  it('pins the common countries to the top, GB first', () => {
    const ordered = orderedPhoneCountries()
    expect(ordered.slice(0, PINNED_DIAL_ISOS.length).map((c) => c.code)).toEqual([
      ...PINNED_DIAL_ISOS,
    ])
    expect(ordered[0]?.code).toBe('gb')
  })

  it('contains every country exactly once', () => {
    const ordered = orderedPhoneCountries()
    expect(ordered).toHaveLength(PHONE_COUNTRIES.length)
    expect(new Set(ordered.map((c) => c.code)).size).toBe(PHONE_COUNTRIES.length)
  })
})
