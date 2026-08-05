// Regression: the intl-tel-input phone widget's country selection must reach the
// resolver (2026-08 live bug).
//
// Every site's Contact Form 7 form pairs `[tel* customer-mobile webhook:phone]`
// with an intl-tel-input widget, which posts the picked dial code as a hidden
// `intl_country_code=+20` field. That field name was absent from the country
// synonyms, so the enquirer's own selection was parked in `extraFields` and the
// resolver fell through to IP geolocation — which returns the mobile carrier's
// regional transit hub, not the enquirer's country (Egypt→France,
// Malaysia→Singapore, Nigeria→Netherlands, Liberia→Côte d'Ivoire, Bhutan→India,
// Türkiye→Germany, Kyrgyzstan→UK). The number was then composed against that
// wrong dial code into structurally valid — and completely undialable — E.164.
//
// The rows below are the real reported corruptions. Each asserts the number the
// customer actually has, submitted exactly as the live form submits it, while the
// IP still geolocates to the wrong country. The geo stub is deliberately hostile:
// if the form signal is ever dropped again, every row fails.

import { describe, expect, it } from 'vitest'

import { normaliseLead } from './normalise'
import { resolveLeadPhoneAndCountry } from './phone-country'

/** Hostile stub: every IP resolves to the transit hub, never the real country. */
function geoTo(iso2: string) {
  return async () => iso2
}

/** Submit exactly what the live CF7 + intl-tel-input form posts. */
async function submit(args: {
  typed: string
  dialCode: string
  geoIso2: string
}): Promise<string | null> {
  const n = normaliseLead({
    fields: {
      'webhook:name': 'Test Enquirer',
      'webhook:phone': args.typed,
      'webhook:email': 'enquirer@example.com',
      intl_country_code: args.dialCode,
      _remote_ip: '203.0.113.9',
    },
    headers: { ip: '198.51.100.4' },
  })
  const r = await resolveLeadPhoneAndCountry(
    {
      formCountry: n.country,
      phoneDisplay: n.phone,
      phoneE164: n.phoneE164,
      phoneAssumedCountry: n.phoneAssumedCountry,
      aiCountryCode: null,
      visitorIp: n.clientIp,
      transportIp: '198.51.100.4',
    },
    geoTo(args.geoIso2),
  )
  return r.phoneE164
}

/** [who, typed nationally, widget dial code, IP geolocates to, correct E.164] */
const REPORTED: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['Egypt → France', '01201164781', '+20', 'FR', '+201201164781'],
  ['Nigeria → Netherlands', '08168997605', '+234', 'NL', '+2348168997605'],
  ['Malaysia → Singapore', '0123070347', '+60', 'SG', '+60123070347'],
  ['Indonesia → Singapore', '088268034931', '+62', 'SG', '+6288268034931'],
  ['Malaysia → Singapore (2)', '0117765818', '+60', 'SG', '+60117765818'],
  ['Malaysia → Singapore (3)', '0167156304', '+60', 'SG', '+60167156304'],
  ["Liberia → Côte d'Ivoire", '0887066541', '+231', 'CI', '+231887066541'],
  ['Egypt → France (2)', '01001861466', '+20', 'FR', '+201001861466'],
  ['Liberia → Netherlands', '0881909591', '+231', 'NL', '+231881909591'],
  ['Egypt → Italy', '01143336878', '+20', 'IT', '+201143336878'],
  ['Lebanon → France', '070286253', '+961', 'FR', '+96170286253'],
  ['Bhutan → India', '077800970', '+975', 'IN', '+97577800970'],
  ['Türkiye → Germany', '05373593668', '+90', 'DE', '+905373593668'],
  ["Côte d'Ivoire → France", '0507153136', '+225', 'FR', '+2250507153136'],
  ['Kyrgyzstan → UK', '0755007381', '+996', 'GB', '+996755007381'],
]

describe('intl-tel-input country selection reaches the resolver', () => {
  it.each(REPORTED)('%s', async (_label, typed, dialCode, geoIso2, expected) => {
    expect(await submit({ typed, dialCode, geoIso2 })).toBe(expected)
  })

  it('the widget dial code beats a contradicting IP geolocation', async () => {
    // The whole point: the customer's own selection outranks any geo guess.
    expect(await submit({ typed: '01201164781', dialCode: '+20', geoIso2: 'FR' })).toBe(
      '+201201164781',
    )
  })

  it('accepts the country as an ISO2 code or a name, not just a dial code', async () => {
    expect(await submit({ typed: '01201164781', dialCode: 'EG', geoIso2: 'FR' })).toBe(
      '+201201164781',
    )
    expect(await submit({ typed: '01201164781', dialCode: 'Egypt', geoIso2: 'FR' })).toBe(
      '+201201164781',
    )
  })

  it('still resolves a genuine UK enquirer', async () => {
    expect(await submit({ typed: '07700900123', dialCode: '+44', geoIso2: 'GB' })).toBe(
      '+447700900123',
    )
  })

  it('leaves an already-international number untouched', async () => {
    expect(await submit({ typed: '+201201164781', dialCode: '+20', geoIso2: 'FR' })).toBe(
      '+201201164781',
    )
  })

  it('retains the leading zero where it belongs to the number (IT, CI)', async () => {
    // Italian landline: +39 06… keeps the 0.
    expect(await submit({ typed: '0612345678', dialCode: '+39', geoIso2: 'GB' })).toBe(
      '+390612345678',
    )
    // Côte d'Ivoire since the 2021 renumbering: 10 digits including the leading 0.
    expect(await submit({ typed: '0507153136', dialCode: '+225', geoIso2: 'GB' })).toBe(
      '+2250507153136',
    )
  })

  it('drops the trunk zero everywhere it is a trunk prefix', async () => {
    expect(await submit({ typed: '08168997605', dialCode: '+234', geoIso2: 'GB' })).toBe(
      '+2348168997605',
    )
  })
})
