import { describe, expect, it } from 'vitest'

import { proposePhoneRepair } from './phone-repair'

/** A stored CF7 RawLeadInput with the given fields. */
function raw(fields: Record<string, unknown>) {
  return { fields, headers: { ip: '172.70.248.140' } }
}

describe('proposePhoneRepair — corrects the mangled numbers from the original enquiry', () => {
  it('recovers +44 from a "Country code: +44" enquiry stored as a wrong +49… (Luise Scharf)', async () => {
    const p = await proposePhoneRepair({
      currentPhoneE164: '+4979990856600',
      rawPayload: raw({
        Name: 'Luise Scharf',
        'Phone Number': '7990856600',
        'Country code': '+44',
        Email: 'luisemariescharf@gmail.com',
      }),
    })
    expect(p?.proposedPhoneE164).toBe('+447990856600')
    expect(p?.proposedCountry).toBe('United Kingdom')
    expect(p?.countrySource).toBe('form')
  })

  it('recovers +964 from a "Country code: +964" enquiry stored as a wrong +359… (Ahmed)', async () => {
    const p = await proposePhoneRepair({
      currentPhoneE164: '+3597857510917',
      rawPayload: raw({
        Name: 'Ahmed Laith Abdullah',
        Phone: '0785 751 0917',
        'Country code': '+964',
        Email: 'agvehssgz@gmail.com',
      }),
    })
    expect(p?.proposedPhoneE164).toBe('+9647857510917')
    expect(p?.proposedCountry).toBe('Iraq')
    expect(p?.countrySource).toBe('form')
  })

  it('recovers a number from an explicitly international phone (no country field)', async () => {
    const p = await proposePhoneRepair({
      currentPhoneE164: '+440091234567', // nonsense the bug could have produced
      rawPayload: raw({ Name: 'X', Phone: '+91 98765 43210' }),
    })
    expect(p?.proposedPhoneE164).toBe('+919876543210')
    expect(p?.countrySource).toBe('phone_dial')
  })
})

describe('proposePhoneRepair — never touches a number it cannot confidently correct', () => {
  it('returns null when the re-derived number already matches (idempotent)', async () => {
    const p = await proposePhoneRepair({
      currentPhoneE164: '+447990856600',
      rawPayload: raw({ 'Phone Number': '7990856600', 'Country code': '+44' }),
    })
    expect(p).toBeNull()
  })

  it('returns null for a plain UK national number with no country field (no confident signal)', async () => {
    // A "07…" with no country field resolves via the UK guess only — not a
    // customer-stated signal — so it is left exactly as-is.
    const p = await proposePhoneRepair({
      currentPhoneE164: '+447700900123',
      rawPayload: raw({ Phone: '07700 900123' }),
    })
    expect(p).toBeNull()
  })

  it('returns null when there was no phone on the enquiry', async () => {
    const p = await proposePhoneRepair({
      currentPhoneE164: null,
      rawPayload: raw({ Name: 'No Phone', Email: 'x@example.com' }),
    })
    expect(p).toBeNull()
  })

  it('returns null when the stored payload is not a re-normalisable shape', async () => {
    expect(await proposePhoneRepair({ currentPhoneE164: '+49x', rawPayload: null })).toBeNull()
    expect(await proposePhoneRepair({ currentPhoneE164: '+49x', rawPayload: 'nope' })).toBeNull()
    expect(
      await proposePhoneRepair({ currentPhoneE164: '+49x', rawPayload: { nope: true } }),
    ).toBeNull()
  })
})
