import { describe, expect, it } from 'vitest'

import {
  asTypedPhoneFallback,
  composePhoneE164,
  dialCountryFromPhone,
  DIAL_COUNTRIES,
  findDialCountry,
  inferPhoneE164,
} from './dial-codes'

describe('dialCountryFromPhone', () => {
  it('resolves the country from an E.164 dial code', () => {
    expect(dialCountryFromPhone('+51928812118')?.iso2).toBe('PE')
    expect(dialCountryFromPhone('+447700900123')?.iso2).toBe('GB')
    expect(dialCountryFromPhone('00971501234567')?.iso2).toBe('AE')
  })
  it('does not guess from a national (non-international) number', () => {
    expect(dialCountryFromPhone('07700900123')).toBeNull()
    expect(dialCountryFromPhone('928812118')).toBeNull()
  })
  it('returns null for junk / empty', () => {
    expect(dialCountryFromPhone(null)).toBeNull()
    expect(dialCountryFromPhone('+123')).toBeNull()
    expect(dialCountryFromPhone('')).toBeNull()
  })
})

describe('DIAL_COUNTRIES table', () => {
  it('has unique ISO2 codes', () => {
    const codes = DIAL_COUNTRIES.map((c) => c.iso2)
    expect(new Set(codes).size).toBe(codes.length)
  })
  it('every dial code is 1-4 digits with no leading zero', () => {
    for (const c of DIAL_COUNTRIES) {
      expect(c.dial, `${c.iso2} dial`).toMatch(/^[1-9]\d{0,3}$/u)
    }
  })
  it('is a prefix code — no dial code is a strict prefix of another (so inference is unambiguous)', () => {
    const dials = [...new Set(DIAL_COUNTRIES.map((c) => c.dial))]
    for (const a of dials) {
      for (const b of dials) {
        if (a === b) continue
        expect(b.startsWith(a), `${a} is a prefix of ${b}`).toBe(false)
      }
    }
  })
  it('covers the previously-missing regions (Caribbean, Africa, Pacific, Central Asia)', () => {
    for (const iso2 of ['HT', 'CU', 'GT', 'ML', 'CD', 'AO', 'MN', 'LA', 'PG', 'WS', 'KG', 'PS']) {
      expect(findDialCountry(iso2), iso2).not.toBeNull()
    }
  })
})

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
  it('resolves long-form and local spellings', () => {
    expect(findDialCountry('Ivory Coast')?.iso2).toBe('CI')
    expect(findDialCountry('Russian Federation')?.iso2).toBe('RU')
    expect(findDialCountry('Viet Nam')?.iso2).toBe('VN')
    expect(findDialCountry('Swaziland')?.iso2).toBe('SZ')
    expect(findDialCountry('The Bahamas')?.iso2).toBe('BS')
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
  it('KEEPS the trunk zero for countries that retain it (Italy: +39 06…)', () => {
    // Regression: Italy is the exception — the leading 0 is part of the
    // international number. Stripping it produced a wrong, undialable E.164.
    expect(composePhoneE164(findDialCountry('IT')!, '06 1234 5678')).toBe('+390612345678')
  })
  it('tolerates the dial code typed inline', () => {
    expect(composePhoneE164(peru, '51 928 812 118')).toBe('+51928812118')
    expect(composePhoneE164(peru, '0051 928 812 118')).toBe('+51928812118')
  })
  it('composes for the newly-added countries', () => {
    expect(composePhoneE164(findDialCountry('Haiti')!, '34 12 34 56')).toBe('+50934123456')
    expect(composePhoneE164(findDialCountry('Mongolia')!, '8812 3456')).toBe('+97688123456')
  })
  it('refuses junk that cannot be a phone number', () => {
    expect(composePhoneE164(uk, '123')).toBeNull()
    expect(composePhoneE164(uk, '')).toBeNull()
  })
})

describe('inferPhoneE164', () => {
  it('infers a dial code typed without the + (the Peru case with code)', () => {
    expect(inferPhoneE164('51 928 812 118')).toBe('+51928812118')
  })
  it('infers NANP numbers typed with the leading 1', () => {
    expect(inferPhoneE164('1 212 555 1234')).toBe('+12125551234')
  })
  it('handles 00-prefixed international dialling', () => {
    expect(inferPhoneE164('0051 928 812 118')).toBe('+51928812118')
  })
  it('never misreads a 9-10 digit national number as international', () => {
    // Spanish national (9 digits) and a UK mobile without its 0 (10 digits):
    // both too short for inference — they go to country-composition instead.
    expect(inferPhoneE164('928 812 118')).toBeNull()
    expect(inferPhoneE164('7700 900123')).toBeNull()
  })
  it('rejects trunk-zero numbers and over-long digit strings', () => {
    expect(inferPhoneE164('07700 900123')).toBeNull()
    expect(inferPhoneE164('1234567890123456')).toBeNull()
  })
})

describe('asTypedPhoneFallback', () => {
  it('keeps the digits as typed so the contact still carries the number', () => {
    expect(asTypedPhoneFallback('928 812 118')).toBe('928812118')
  })
  it('preserves a leading +', () => {
    expect(asTypedPhoneFallback('+999 123 456 789 0123')).toBe('+9991234567890123')
  })
  it('rejects strings that cannot be a phone number at all', () => {
    expect(asTypedPhoneFallback('123')).toBeNull()
    expect(asTypedPhoneFallback('call me anytime')).toBeNull()
  })
})
