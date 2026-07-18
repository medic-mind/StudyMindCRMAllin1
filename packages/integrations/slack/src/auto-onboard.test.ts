import { describe, expect, it } from 'vitest'

import { callLogNameFromFirstLine, normaliseSlackPhoneToE164, onboardDecision } from './auto-onboard'
import { isOwnBrandEmail, isOwnBrandName, type OwnBrands } from './own-brands'

const BRANDS: OwnBrands = {
  names: new Set(['medic mind', 'study mind', 'oxbridge mind']),
  domains: ['medicmind.co.uk', 'studymind.co.uk'],
}

describe('normaliseSlackPhoneToE164', () => {
  it('fixes the malformed +44 0… paste the team uses', () => {
    expect(normaliseSlackPhoneToE164('+4407818953024')).toBe('+447818953024')
    expect(normaliseSlackPhoneToE164('4407818953024')).toBe('+447818953024')
  })

  it('handles national, 00-international and bare dial-code forms', () => {
    expect(normaliseSlackPhoneToE164('07818 953024')).toBe('+447818953024')
    expect(normaliseSlackPhoneToE164('00447818953024')).toBe('+447818953024')
    expect(normaliseSlackPhoneToE164('447818953024')).toBe('+447818953024')
    expect(normaliseSlackPhoneToE164('+393311585415')).toBe('+393311585415')
    expect(normaliseSlackPhoneToE164('60128870168')).toBe('+60128870168')
  })

  it('rejects runs that cannot be diallable numbers', () => {
    expect(normaliseSlackPhoneToE164('12345')).toBeNull()
    expect(normaliseSlackPhoneToE164('1234567890123456')).toBeNull()
  })
})

describe('callLogNameFromFirstLine', () => {
  it('reads the name before the phone, dropping flag emoji codes', () => {
    expect(
      callLogNameFromFirstLine(
        ':gb:Aviral Sethi <tel:+4407818953024|+4407818953024> Medic Mind\n• Interview on 21st July',
      ),
    ).toBe('Aviral Sethi')
  })

  it('handles lower-case names the proper-noun extractor cannot see', () => {
    expect(callLogNameFromFirstLine('kinza shahzad <tel:+4407490033312|+4407490033312>')).toBe(
      'kinza shahzad',
    )
  })

  it('gives up on headers that are not name-shaped', () => {
    // Five words before the phone — a description, not a name.
    expect(
      callLogNameFromFirstLine('Dr. Liew for son Jia <tel:+60128870168|+60128870168> UCAT'),
    ).toBeNull()
    expect(callLogNameFromFirstLine('• bullet only, no phone')).toBeNull()
  })
})

describe('onboardDecision', () => {
  const base = {
    isBrandName: (n: string) => isOwnBrandName(n, BRANDS),
    isBrandEmail: (e: string) => isOwnBrandEmail(e, BRANDS),
  }

  it('onboards a phone-bearing call log with the header name', () => {
    const d = onboardDecision({
      ...base,
      messageText: ':gb:Aviral Sethi <tel:+4407818953024|+4407818953024> Medic Mind',
      phone: '+4407818953024',
      email: null,
      nameCandidates: ['Aviral Sethi', 'Medic Mind'],
    })
    expect(d).toEqual({ phoneE164: '+447818953024', name: 'Aviral Sethi', email: null })
  })

  it('never uses an own brand as the person name', () => {
    const d = onboardDecision({
      ...base,
      messageText: 'Medic Mind <tel:+447700900123|+447700900123>',
      phone: '+447700900123',
      email: null,
      nameCandidates: ['Medic Mind'],
    })
    expect(d).toEqual({ phoneE164: '+447700900123', name: null, email: null })
  })

  it('drops own-brand emails but keeps the customer one', () => {
    const d = onboardDecision({
      ...base,
      messageText: 'Irina Ramzan <tel:+447868281951|+447868281951>',
      phone: '+447868281951',
      email: 'info@medicmind.co.uk',
      nameCandidates: ['Irina Ramzan'],
    })
    expect(d?.email).toBeNull()
    expect(d?.name).toBe('Irina Ramzan')
  })

  it('never onboards without a phone — name-only chatter stays parked (§11)', () => {
    expect(
      onboardDecision({
        ...base,
        messageText: 'Spoke to Aanya Sharma about the mocks',
        phone: null,
        email: null,
        nameCandidates: ['Aanya Sharma'],
      }),
    ).toBeNull()
  })
})
