import { describe, expect, it } from 'vitest'

import { normalisePhone } from './normalise'
import { resolveLeadPhoneAndCountry, type ResolvePhoneCountryInput } from './phone-country'

// A fake geolocator: maps an IP → ISO2. The UK WordPress host is 1.1.1.1 (the
// real-world bug — CF7 posts server-side, so the transport IP is the host).
const HOST_UK = '1.1.1.1'
const VISITOR_IN = '203.0.113.7'
function geo(map: Record<string, string>): (ip: string) => Promise<string | null> {
  return async (ip: string) => map[ip] ?? null
}

/** Build the resolver input the way process-lead does: run normalisePhone on
 *  the typed value, then hand its pieces + the surrounding signals in. */
function input(
  typed: string,
  extra: Partial<ResolvePhoneCountryInput> = {},
): ResolvePhoneCountryInput {
  const n = normalisePhone(typed)
  return {
    formCountry: null,
    phoneDisplay: n.display,
    phoneE164: n.e164,
    phoneAssumedCountry: n.assumedCountry,
    aiCountryCode: null,
    visitorIp: null,
    transportIp: null,
    ...extra,
  }
}

describe('resolveLeadPhoneAndCountry — international phone fix', () => {
  it('an explicit +country-code number is kept verbatim and never mangled by the host IP', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('+91 98765 43210', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+919876543210')
    expect(res.country?.iso2).toBe('IN')
    expect(res.countrySource).toBe('phone_dial')
  })

  it('a dial code typed WITHOUT the + still wins over the UK host IP (the reported bug)', async () => {
    // "91 98765 43210" — the customer gave their country code; it must take
    // priority over the WordPress host geolocating to GB.
    const res = await resolveLeadPhoneAndCountry(
      input('91 98765 43210', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+919876543210')
    expect(res.country?.iso2).toBe('IN')
    expect(res.countrySource).toBe('phone_dial')
  })

  it('a 00-prefixed international number is kept, not re-prefixed with +44', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('0051 928 812 118', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+51928812118')
    expect(res.country?.iso2).toBe('PE')
  })

  it('the AI country beats the UK host IP for a bare national number (no + given)', async () => {
    // "09876543210" is a UK-shaped guess (+44); with no form country and only
    // the host transport IP, the AI's read of the enquiry (India) must win, so
    // the number recomposes to +91 rather than staying +44.
    const res = await resolveLeadPhoneAndCountry(
      input('09876543210', { aiCountryCode: 'IN', transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+919876543210')
    expect(res.country?.iso2).toBe('IN')
    expect(res.countrySource).toBe('ai')
  })

  it('a form-forwarded visitor IP resolves the country and beats the host IP', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('09876543210', { visitorIp: VISITOR_IN, transportIp: HOST_UK }),
      geo({ [VISITOR_IN]: 'IN', [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+919876543210')
    expect(res.country?.iso2).toBe('IN')
    expect(res.countrySource).toBe('visitor_ip')
  })

  it('the form country field wins over everything', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('09876543210', {
        formCountry: 'India',
        aiCountryCode: 'FR',
        visitorIp: VISITOR_IN,
        transportIp: HOST_UK,
      }),
      geo({ [VISITOR_IN]: 'AE', [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+919876543210')
    expect(res.country?.iso2).toBe('IN')
    expect(res.countrySource).toBe('form')
  })
})

describe('resolveLeadPhoneAndCountry — the UK path is unaffected', () => {
  it('a UK mobile with the trunk 0 stays +44 (host IP = UK)', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('07700 900123', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    expect(res.phoneE164).toBe('+447700900123')
    expect(res.country?.iso2).toBe('GB')
    expect(res.countrySource).toBe('transport_ip')
  })

  it('an explicit +44 number resolves to GB from its own code', async () => {
    const res = await resolveLeadPhoneAndCountry(input('+44 7700 900123'))
    expect(res.phoneE164).toBe('+447700900123')
    expect(res.country?.iso2).toBe('GB')
    expect(res.countrySource).toBe('phone_dial')
  })

  it('a guessed +44 is NOT rewritten to a non-UK country off the transport (host) IP', async () => {
    // If the host box were mis-located to Ireland, a UK-shaped 07… number must
    // NOT become +353… — the host IP says nothing about the enquirer.
    const res = await resolveLeadPhoneAndCountry(
      input('07700900123', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'IE' }),
    )
    expect(res.phoneE164).toBe('+447700900123')
  })

  it('with no signal at all a guessed +44 is kept (never lost)', async () => {
    const res = await resolveLeadPhoneAndCountry(input('07700900123'))
    expect(res.phoneE164).toBe('+447700900123')
    expect(res.countrySource).toBeNull()
  })
})

describe('resolveLeadPhoneAndCountry — last-resort behaviour', () => {
  it('a bare national number with no country signal composes with the host country (UK majority)', async () => {
    const res = await resolveLeadPhoneAndCountry(
      input('9876543210', { transportIp: HOST_UK }),
      geo({ [HOST_UK]: 'GB' }),
    )
    // No form / phone-dial / visitor-IP / AI signal → the host country is the
    // only guess. Correct for the UK majority; overseas needs the visitor IP.
    expect(res.phoneE164).toBe('+449876543210')
    expect(res.countrySource).toBe('transport_ip')
  })

  it('keeps a typed number as-typed when nothing can compose it', async () => {
    const res = await resolveLeadPhoneAndCountry(input('123456'))
    // No country signal + not a UK/intl shape → stored as typed so it is never
    // silently lost (an agent can add the prefix).
    expect(res.phoneE164).toBe('123456')
  })

  it('drops a value too short to be a phone number at all', async () => {
    const res = await resolveLeadPhoneAndCountry(input('12345'))
    expect(res.phoneE164).toBeNull()
  })

  it('returns null phone when there was no phone', async () => {
    const res = await resolveLeadPhoneAndCountry({
      formCountry: null,
      phoneDisplay: null,
      phoneE164: null,
      phoneAssumedCountry: null,
      aiCountryCode: null,
      visitorIp: null,
      transportIp: null,
    })
    expect(res.phoneE164).toBeNull()
    expect(res.country).toBeNull()
  })
})
