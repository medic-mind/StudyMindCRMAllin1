import { describe, expect, it } from 'vitest'

import { composePhoneE164, findDialCountry } from './dial-codes'

describe('findDialCountry', () => {
  it('resolves by ISO2 code', () => {
    expect(findDialCountry('PE')?.name).toBe('Peru')
    expect(findDialCountry('gb')?.dial).toBe('44')
  })
  it('resolves by English name, case-insensitive', () => {
    expect(findDialCountry('peru')?.dial).toBe('51')
    expect(findDialCountry('United Kingdom')?.iso2).toBe('GB')
  })
  it('resolves common aliases (UK, USA, UAE)', () => {
    expect(findDialCountry('UK')?.iso2).toBe('GB')
    expect(findDialCountry('USA')?.iso2).toBe('US')
    expect(findDialCountry('uae')?.iso2).toBe('AE')
  })
  it('returns null for unknowns', () => {
    expect(findDialCountry('Atlantis')).toBeNull()
    expect(findDialCountry('')).toBeNull()
    expect(findDialCountry(null)).toBeNull()
  })
})

describe('composePhoneE164', () => {
  const peru = findDialCountry('PE')!
  const uk = findDialCountry('GB')!

  it('composes a Peruvian mobile typed nationally (the live bug)', () => {
    expect(composePhoneE164(peru, '928 812 118')).toBe('+51928812118')
  })
  it('strips a trunk zero before prepending the dial code', () => {
    expect(composePhoneE164(uk, '07700 900123')).toBe('+447700900123')
  })
  it('tolerates the dial code typed inline', () => {
    expect(composePhoneE164(peru, '51 928 812 118')).toBe('+51928812118')
    expect(composePhoneE164(peru, '0051 928 812 118')).toBe('+51928812118')
  })
  it('refuses junk that cannot be a phone number', () => {
    expect(composePhoneE164(uk, '123')).toBeNull()
    expect(composePhoneE164(uk, '')).toBeNull()
  })
})
