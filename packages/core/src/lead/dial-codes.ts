// Country dial codes for lead phone composition (ADR 0023 follow-up).
//
// A web enquirer often types their phone in national format ("928 812 118").
// The UK heuristics in normalisePhone cover UK shapes; for everyone else we
// resolve a country (the form's country field, else IP geolocation) and
// compose E.164 here: +<dial><national-number-without-trunk-0>. Pure data +
// helpers — duplicated in spirit from apps/web/components/ui/phone.ts, which
// core/jobs cannot import (module boundaries, CLAUDE.md §5).

export interface DialCountry {
  /** ISO 3166-1 alpha-2. */
  iso2: string
  /** English short name (matches what country form fields usually post). */
  name: string
  /** Dial code without the +. */
  dial: string
}

// Common-market countries first for readability; lookup is by map, order
// doesn't matter. Covers every country an enquiry has plausibly come from;
// extend freely — unknown countries simply fall back to "no compose".
export const DIAL_COUNTRIES: readonly DialCountry[] = [
  { iso2: 'GB', name: 'United Kingdom', dial: '44' },
  { iso2: 'IE', name: 'Ireland', dial: '353' },
  { iso2: 'US', name: 'United States', dial: '1' },
  { iso2: 'CA', name: 'Canada', dial: '1' },
  { iso2: 'AU', name: 'Australia', dial: '61' },
  { iso2: 'NZ', name: 'New Zealand', dial: '64' },
  { iso2: 'IN', name: 'India', dial: '91' },
  { iso2: 'PK', name: 'Pakistan', dial: '92' },
  { iso2: 'BD', name: 'Bangladesh', dial: '880' },
  { iso2: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso2: 'NG', name: 'Nigeria', dial: '234' },
  { iso2: 'GH', name: 'Ghana', dial: '233' },
  { iso2: 'KE', name: 'Kenya', dial: '254' },
  { iso2: 'ZA', name: 'South Africa', dial: '27' },
  { iso2: 'EG', name: 'Egypt', dial: '20' },
  { iso2: 'MA', name: 'Morocco', dial: '212' },
  { iso2: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso2: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso2: 'QA', name: 'Qatar', dial: '974' },
  { iso2: 'KW', name: 'Kuwait', dial: '965' },
  { iso2: 'BH', name: 'Bahrain', dial: '973' },
  { iso2: 'OM', name: 'Oman', dial: '968' },
  { iso2: 'JO', name: 'Jordan', dial: '962' },
  { iso2: 'LB', name: 'Lebanon', dial: '961' },
  { iso2: 'IL', name: 'Israel', dial: '972' },
  { iso2: 'TR', name: 'Turkey', dial: '90' },
  { iso2: 'FR', name: 'France', dial: '33' },
  { iso2: 'DE', name: 'Germany', dial: '49' },
  { iso2: 'ES', name: 'Spain', dial: '34' },
  { iso2: 'PT', name: 'Portugal', dial: '351' },
  { iso2: 'IT', name: 'Italy', dial: '39' },
  { iso2: 'NL', name: 'Netherlands', dial: '31' },
  { iso2: 'BE', name: 'Belgium', dial: '32' },
  { iso2: 'LU', name: 'Luxembourg', dial: '352' },
  { iso2: 'CH', name: 'Switzerland', dial: '41' },
  { iso2: 'AT', name: 'Austria', dial: '43' },
  { iso2: 'DK', name: 'Denmark', dial: '45' },
  { iso2: 'SE', name: 'Sweden', dial: '46' },
  { iso2: 'NO', name: 'Norway', dial: '47' },
  { iso2: 'FI', name: 'Finland', dial: '358' },
  { iso2: 'IS', name: 'Iceland', dial: '354' },
  { iso2: 'PL', name: 'Poland', dial: '48' },
  { iso2: 'CZ', name: 'Czechia', dial: '420' },
  { iso2: 'SK', name: 'Slovakia', dial: '421' },
  { iso2: 'HU', name: 'Hungary', dial: '36' },
  { iso2: 'RO', name: 'Romania', dial: '40' },
  { iso2: 'BG', name: 'Bulgaria', dial: '359' },
  { iso2: 'GR', name: 'Greece', dial: '30' },
  { iso2: 'CY', name: 'Cyprus', dial: '357' },
  { iso2: 'MT', name: 'Malta', dial: '356' },
  { iso2: 'HR', name: 'Croatia', dial: '385' },
  { iso2: 'SI', name: 'Slovenia', dial: '386' },
  { iso2: 'RS', name: 'Serbia', dial: '381' },
  { iso2: 'UA', name: 'Ukraine', dial: '380' },
  { iso2: 'LT', name: 'Lithuania', dial: '370' },
  { iso2: 'LV', name: 'Latvia', dial: '371' },
  { iso2: 'EE', name: 'Estonia', dial: '372' },
  { iso2: 'RU', name: 'Russia', dial: '7' },
  { iso2: 'CN', name: 'China', dial: '86' },
  { iso2: 'HK', name: 'Hong Kong', dial: '852' },
  { iso2: 'MO', name: 'Macau', dial: '853' },
  { iso2: 'TW', name: 'Taiwan', dial: '886' },
  { iso2: 'JP', name: 'Japan', dial: '81' },
  { iso2: 'KR', name: 'South Korea', dial: '82' },
  { iso2: 'SG', name: 'Singapore', dial: '65' },
  { iso2: 'MY', name: 'Malaysia', dial: '60' },
  { iso2: 'TH', name: 'Thailand', dial: '66' },
  { iso2: 'VN', name: 'Vietnam', dial: '84' },
  { iso2: 'PH', name: 'Philippines', dial: '63' },
  { iso2: 'ID', name: 'Indonesia', dial: '62' },
  { iso2: 'BN', name: 'Brunei', dial: '673' },
  { iso2: 'MX', name: 'Mexico', dial: '52' },
  { iso2: 'BR', name: 'Brazil', dial: '55' },
  { iso2: 'AR', name: 'Argentina', dial: '54' },
  { iso2: 'CL', name: 'Chile', dial: '56' },
  { iso2: 'CO', name: 'Colombia', dial: '57' },
  { iso2: 'PE', name: 'Peru', dial: '51' },
  { iso2: 'EC', name: 'Ecuador', dial: '593' },
  { iso2: 'VE', name: 'Venezuela', dial: '58' },
  { iso2: 'BO', name: 'Bolivia', dial: '591' },
  { iso2: 'PY', name: 'Paraguay', dial: '595' },
  { iso2: 'UY', name: 'Uruguay', dial: '598' },
  { iso2: 'CR', name: 'Costa Rica', dial: '506' },
  { iso2: 'PA', name: 'Panama', dial: '507' },
  { iso2: 'DO', name: 'Dominican Republic', dial: '1' },
  { iso2: 'JM', name: 'Jamaica', dial: '1' },
  { iso2: 'TT', name: 'Trinidad and Tobago', dial: '1' },
  { iso2: 'BB', name: 'Barbados', dial: '1' },
  { iso2: 'ZW', name: 'Zimbabwe', dial: '263' },
  { iso2: 'ZM', name: 'Zambia', dial: '260' },
  { iso2: 'UG', name: 'Uganda', dial: '256' },
  { iso2: 'TZ', name: 'Tanzania', dial: '255' },
  { iso2: 'ET', name: 'Ethiopia', dial: '251' },
  { iso2: 'RW', name: 'Rwanda', dial: '250' },
  { iso2: 'MW', name: 'Malawi', dial: '265' },
  { iso2: 'MZ', name: 'Mozambique', dial: '258' },
  { iso2: 'BW', name: 'Botswana', dial: '267' },
  { iso2: 'NA', name: 'Namibia', dial: '264' },
  { iso2: 'SN', name: 'Senegal', dial: '221' },
  { iso2: 'CI', name: "Cote d'Ivoire", dial: '225' },
  { iso2: 'CM', name: 'Cameroon', dial: '237' },
  { iso2: 'DZ', name: 'Algeria', dial: '213' },
  { iso2: 'TN', name: 'Tunisia', dial: '216' },
  { iso2: 'LY', name: 'Libya', dial: '218' },
  { iso2: 'SD', name: 'Sudan', dial: '249' },
  { iso2: 'IQ', name: 'Iraq', dial: '964' },
  { iso2: 'IR', name: 'Iran', dial: '98' },
  { iso2: 'AF', name: 'Afghanistan', dial: '93' },
  { iso2: 'NP', name: 'Nepal', dial: '977' },
  { iso2: 'MM', name: 'Myanmar', dial: '95' },
  { iso2: 'KH', name: 'Cambodia', dial: '855' },
  { iso2: 'KZ', name: 'Kazakhstan', dial: '7' },
  { iso2: 'UZ', name: 'Uzbekistan', dial: '998' },
  { iso2: 'AZ', name: 'Azerbaijan', dial: '994' },
  { iso2: 'GE', name: 'Georgia', dial: '995' },
  { iso2: 'AM', name: 'Armenia', dial: '374' },
  { iso2: 'AL', name: 'Albania', dial: '355' },
  { iso2: 'MK', name: 'North Macedonia', dial: '389' },
  { iso2: 'BA', name: 'Bosnia and Herzegovina', dial: '387' },
  { iso2: 'MD', name: 'Moldova', dial: '373' },
  { iso2: 'BY', name: 'Belarus', dial: '375' },
  { iso2: 'MV', name: 'Maldives', dial: '960' },
  { iso2: 'MU', name: 'Mauritius', dial: '230' },
  { iso2: 'FJ', name: 'Fiji', dial: '679' },
]

const BY_ISO2 = new Map(DIAL_COUNTRIES.map((c) => [c.iso2, c]))
const BY_NAME = new Map(DIAL_COUNTRIES.map((c) => [c.name.toLowerCase(), c]))

// Common alternative spellings a form's country dropdown might post.
const NAME_ALIASES: Record<string, string> = {
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'northern ireland': 'GB',
  usa: 'US',
  'united states of america': 'US',
  uae: 'AE',
  'czech republic': 'CZ',
  'south korea': 'KR',
  'republic of ireland': 'IE',
  türkiye: 'TR',
  turkiye: 'TR',
}

/** Resolve a country from an ISO2 code or an English name/alias. */
export function findDialCountry(token: string | null | undefined): DialCountry | null {
  if (!token) return null
  const t = token.trim()
  if (!t) return null
  if (t.length === 2) {
    const hit = BY_ISO2.get(t.toUpperCase())
    if (hit) return hit
  }
  const lower = t.toLowerCase()
  const byName = BY_NAME.get(lower)
  if (byName) return byName
  const alias = NAME_ALIASES[lower]
  if (alias) return BY_ISO2.get(alias) ?? null
  return null
}

/**
 * Compose E.164 from a country + a nationally-typed number ("928 812 118",
 * Peru → "+51928812118"). Strips the trunk 0, tolerates the dial code being
 * typed inline, and refuses anything outside plausible E.164 lengths so we
 * never store junk in `Contact.phoneE164` (§29).
 */
export function composePhoneE164(country: DialCountry, rawNumber: string): string | null {
  let digits = rawNumber.replace(/[^\d]/gu, '')
  if (!digits) return null
  // Already includes the dial code (typed "0051 …" / "51 928 …").
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith(country.dial) && digits.length >= country.dial.length + 7) {
    const candidate = `+${digits}`
    if (/^\+[1-9]\d{6,14}$/u.test(candidate)) return candidate
  }
  // National format: strip a single trunk 0, prepend the dial code.
  const national = digits.startsWith('0') ? digits.slice(1) : digits
  if (national.length < 6 || national.length > 12) return null
  const candidate = `+${country.dial}${national}`
  return /^\+[1-9]\d{6,14}$/u.test(candidate) ? candidate : null
}
