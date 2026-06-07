import { describe, expect, it } from 'vitest'

import { composePhone, DIAL, parsePhone } from './phone'

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
