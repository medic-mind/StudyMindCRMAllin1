// Country dial codes for lead phone composition (ADR 0023 follow-up).
//
// A web enquirer often types their phone in national format ("928 812 118").
// The UK heuristics in normalisePhone cover UK shapes; for everyone else we
// resolve a country (the form's country field, else IP geolocation) and
// compose E.164 here: +<dial><national-number-without-trunk-0>. Pure data +
// helpers — duplicated in spirit from apps/web/components/ui/phone.ts, which
// core/jobs cannot import (module boundaries, CLAUDE.md §5).
//
// The table is the FULL ISO 3166-1 set (every assigned dial code, including
// shared-code territories like the NANP islands and Crown dependencies) —
// a missing country here means a typed number silently fails to compose,
// which is exactly the live bug this exists to prevent.

export interface DialCountry {
  /** ISO 3166-1 alpha-2. */
  iso2: string
  /** English short name (matches what country form fields usually post). */
  name: string
  /** Dial code without the +. */
  dial: string
}

// Grouped by region for readability; lookup is by map, order doesn't matter.
export const DIAL_COUNTRIES: readonly DialCountry[] = [
  // --- UK + Crown dependencies + Ireland -----------------------------------
  { iso2: 'GB', name: 'United Kingdom', dial: '44' },
  { iso2: 'JE', name: 'Jersey', dial: '44' },
  { iso2: 'GG', name: 'Guernsey', dial: '44' },
  { iso2: 'IM', name: 'Isle of Man', dial: '44' },
  { iso2: 'IE', name: 'Ireland', dial: '353' },
  // --- North America (NANP) -------------------------------------------------
  { iso2: 'US', name: 'United States', dial: '1' },
  { iso2: 'CA', name: 'Canada', dial: '1' },
  { iso2: 'PR', name: 'Puerto Rico', dial: '1' },
  { iso2: 'VI', name: 'U.S. Virgin Islands', dial: '1' },
  { iso2: 'GU', name: 'Guam', dial: '1' },
  { iso2: 'MP', name: 'Northern Mariana Islands', dial: '1' },
  { iso2: 'AS', name: 'American Samoa', dial: '1' },
  { iso2: 'BM', name: 'Bermuda', dial: '1' },
  { iso2: 'BS', name: 'Bahamas', dial: '1' },
  { iso2: 'BB', name: 'Barbados', dial: '1' },
  { iso2: 'JM', name: 'Jamaica', dial: '1' },
  { iso2: 'TT', name: 'Trinidad and Tobago', dial: '1' },
  { iso2: 'DO', name: 'Dominican Republic', dial: '1' },
  { iso2: 'HT', name: 'Haiti', dial: '509' },
  { iso2: 'CU', name: 'Cuba', dial: '53' },
  { iso2: 'KY', name: 'Cayman Islands', dial: '1' },
  { iso2: 'TC', name: 'Turks and Caicos Islands', dial: '1' },
  { iso2: 'VG', name: 'British Virgin Islands', dial: '1' },
  { iso2: 'AI', name: 'Anguilla', dial: '1' },
  { iso2: 'AG', name: 'Antigua and Barbuda', dial: '1' },
  { iso2: 'DM', name: 'Dominica', dial: '1' },
  { iso2: 'GD', name: 'Grenada', dial: '1' },
  { iso2: 'KN', name: 'Saint Kitts and Nevis', dial: '1' },
  { iso2: 'LC', name: 'Saint Lucia', dial: '1' },
  { iso2: 'VC', name: 'Saint Vincent and the Grenadines', dial: '1' },
  { iso2: 'MS', name: 'Montserrat', dial: '1' },
  { iso2: 'SX', name: 'Sint Maarten', dial: '1' },
  { iso2: 'AW', name: 'Aruba', dial: '297' },
  { iso2: 'CW', name: 'Curacao', dial: '599' },
  { iso2: 'BQ', name: 'Caribbean Netherlands', dial: '599' },
  { iso2: 'GP', name: 'Guadeloupe', dial: '590' },
  { iso2: 'BL', name: 'Saint Barthelemy', dial: '590' },
  { iso2: 'MF', name: 'Saint Martin', dial: '590' },
  { iso2: 'MQ', name: 'Martinique', dial: '596' },
  { iso2: 'PM', name: 'Saint Pierre and Miquelon', dial: '508' },
  // --- Central + South America ----------------------------------------------
  { iso2: 'MX', name: 'Mexico', dial: '52' },
  { iso2: 'GT', name: 'Guatemala', dial: '502' },
  { iso2: 'SV', name: 'El Salvador', dial: '503' },
  { iso2: 'HN', name: 'Honduras', dial: '504' },
  { iso2: 'NI', name: 'Nicaragua', dial: '505' },
  { iso2: 'CR', name: 'Costa Rica', dial: '506' },
  { iso2: 'PA', name: 'Panama', dial: '507' },
  { iso2: 'BZ', name: 'Belize', dial: '501' },
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
  { iso2: 'GY', name: 'Guyana', dial: '592' },
  { iso2: 'SR', name: 'Suriname', dial: '597' },
  { iso2: 'GF', name: 'French Guiana', dial: '594' },
  { iso2: 'FK', name: 'Falkland Islands', dial: '500' },
  // --- Western + Northern Europe ---------------------------------------------
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
  { iso2: 'FO', name: 'Faroe Islands', dial: '298' },
  { iso2: 'GL', name: 'Greenland', dial: '299' },
  { iso2: 'MC', name: 'Monaco', dial: '377' },
  { iso2: 'AD', name: 'Andorra', dial: '376' },
  { iso2: 'SM', name: 'San Marino', dial: '378' },
  { iso2: 'VA', name: 'Vatican City', dial: '379' },
  { iso2: 'LI', name: 'Liechtenstein', dial: '423' },
  { iso2: 'GI', name: 'Gibraltar', dial: '350' },
  { iso2: 'MT', name: 'Malta', dial: '356' },
  // --- Central + Eastern Europe ----------------------------------------------
  { iso2: 'PL', name: 'Poland', dial: '48' },
  { iso2: 'CZ', name: 'Czechia', dial: '420' },
  { iso2: 'SK', name: 'Slovakia', dial: '421' },
  { iso2: 'HU', name: 'Hungary', dial: '36' },
  { iso2: 'RO', name: 'Romania', dial: '40' },
  { iso2: 'BG', name: 'Bulgaria', dial: '359' },
  { iso2: 'GR', name: 'Greece', dial: '30' },
  { iso2: 'CY', name: 'Cyprus', dial: '357' },
  { iso2: 'HR', name: 'Croatia', dial: '385' },
  { iso2: 'SI', name: 'Slovenia', dial: '386' },
  { iso2: 'RS', name: 'Serbia', dial: '381' },
  { iso2: 'ME', name: 'Montenegro', dial: '382' },
  { iso2: 'XK', name: 'Kosovo', dial: '383' },
  { iso2: 'BA', name: 'Bosnia and Herzegovina', dial: '387' },
  { iso2: 'MK', name: 'North Macedonia', dial: '389' },
  { iso2: 'AL', name: 'Albania', dial: '355' },
  { iso2: 'UA', name: 'Ukraine', dial: '380' },
  { iso2: 'MD', name: 'Moldova', dial: '373' },
  { iso2: 'BY', name: 'Belarus', dial: '375' },
  { iso2: 'LT', name: 'Lithuania', dial: '370' },
  { iso2: 'LV', name: 'Latvia', dial: '371' },
  { iso2: 'EE', name: 'Estonia', dial: '372' },
  { iso2: 'RU', name: 'Russia', dial: '7' },
  // --- Middle East + North Africa --------------------------------------------
  { iso2: 'TR', name: 'Turkey', dial: '90' },
  { iso2: 'AE', name: 'United Arab Emirates', dial: '971' },
  { iso2: 'SA', name: 'Saudi Arabia', dial: '966' },
  { iso2: 'QA', name: 'Qatar', dial: '974' },
  { iso2: 'KW', name: 'Kuwait', dial: '965' },
  { iso2: 'BH', name: 'Bahrain', dial: '973' },
  { iso2: 'OM', name: 'Oman', dial: '968' },
  { iso2: 'YE', name: 'Yemen', dial: '967' },
  { iso2: 'JO', name: 'Jordan', dial: '962' },
  { iso2: 'LB', name: 'Lebanon', dial: '961' },
  { iso2: 'SY', name: 'Syria', dial: '963' },
  { iso2: 'IL', name: 'Israel', dial: '972' },
  { iso2: 'PS', name: 'Palestine', dial: '970' },
  { iso2: 'IQ', name: 'Iraq', dial: '964' },
  { iso2: 'IR', name: 'Iran', dial: '98' },
  { iso2: 'EG', name: 'Egypt', dial: '20' },
  { iso2: 'MA', name: 'Morocco', dial: '212' },
  { iso2: 'EH', name: 'Western Sahara', dial: '212' },
  { iso2: 'DZ', name: 'Algeria', dial: '213' },
  { iso2: 'TN', name: 'Tunisia', dial: '216' },
  { iso2: 'LY', name: 'Libya', dial: '218' },
  // --- Sub-Saharan Africa ------------------------------------------------------
  { iso2: 'NG', name: 'Nigeria', dial: '234' },
  { iso2: 'GH', name: 'Ghana', dial: '233' },
  { iso2: 'KE', name: 'Kenya', dial: '254' },
  { iso2: 'ZA', name: 'South Africa', dial: '27' },
  { iso2: 'ZW', name: 'Zimbabwe', dial: '263' },
  { iso2: 'ZM', name: 'Zambia', dial: '260' },
  { iso2: 'UG', name: 'Uganda', dial: '256' },
  { iso2: 'TZ', name: 'Tanzania', dial: '255' },
  { iso2: 'ET', name: 'Ethiopia', dial: '251' },
  { iso2: 'ER', name: 'Eritrea', dial: '291' },
  { iso2: 'DJ', name: 'Djibouti', dial: '253' },
  { iso2: 'SO', name: 'Somalia', dial: '252' },
  { iso2: 'SD', name: 'Sudan', dial: '249' },
  { iso2: 'SS', name: 'South Sudan', dial: '211' },
  { iso2: 'RW', name: 'Rwanda', dial: '250' },
  { iso2: 'BI', name: 'Burundi', dial: '257' },
  { iso2: 'MW', name: 'Malawi', dial: '265' },
  { iso2: 'MZ', name: 'Mozambique', dial: '258' },
  { iso2: 'BW', name: 'Botswana', dial: '267' },
  { iso2: 'NA', name: 'Namibia', dial: '264' },
  { iso2: 'LS', name: 'Lesotho', dial: '266' },
  { iso2: 'SZ', name: 'Eswatini', dial: '268' },
  { iso2: 'AO', name: 'Angola', dial: '244' },
  { iso2: 'CD', name: 'DR Congo', dial: '243' },
  { iso2: 'CG', name: 'Congo', dial: '242' },
  { iso2: 'GA', name: 'Gabon', dial: '241' },
  { iso2: 'GQ', name: 'Equatorial Guinea', dial: '240' },
  { iso2: 'CM', name: 'Cameroon', dial: '237' },
  { iso2: 'CF', name: 'Central African Republic', dial: '236' },
  { iso2: 'TD', name: 'Chad', dial: '235' },
  { iso2: 'NE', name: 'Niger', dial: '227' },
  { iso2: 'ML', name: 'Mali', dial: '223' },
  { iso2: 'BF', name: 'Burkina Faso', dial: '226' },
  { iso2: 'SN', name: 'Senegal', dial: '221' },
  { iso2: 'MR', name: 'Mauritania', dial: '222' },
  { iso2: 'GM', name: 'Gambia', dial: '220' },
  { iso2: 'GN', name: 'Guinea', dial: '224' },
  { iso2: 'GW', name: 'Guinea-Bissau', dial: '245' },
  { iso2: 'SL', name: 'Sierra Leone', dial: '232' },
  { iso2: 'LR', name: 'Liberia', dial: '231' },
  { iso2: 'CI', name: "Cote d'Ivoire", dial: '225' },
  { iso2: 'TG', name: 'Togo', dial: '228' },
  { iso2: 'BJ', name: 'Benin', dial: '229' },
  { iso2: 'CV', name: 'Cape Verde', dial: '238' },
  { iso2: 'ST', name: 'Sao Tome and Principe', dial: '239' },
  { iso2: 'SH', name: 'Saint Helena', dial: '290' },
  { iso2: 'SC', name: 'Seychelles', dial: '248' },
  { iso2: 'MU', name: 'Mauritius', dial: '230' },
  { iso2: 'KM', name: 'Comoros', dial: '269' },
  { iso2: 'MG', name: 'Madagascar', dial: '261' },
  { iso2: 'RE', name: 'Reunion', dial: '262' },
  { iso2: 'YT', name: 'Mayotte', dial: '262' },
  // --- South + Central Asia ----------------------------------------------------
  { iso2: 'IN', name: 'India', dial: '91' },
  { iso2: 'PK', name: 'Pakistan', dial: '92' },
  { iso2: 'BD', name: 'Bangladesh', dial: '880' },
  { iso2: 'LK', name: 'Sri Lanka', dial: '94' },
  { iso2: 'NP', name: 'Nepal', dial: '977' },
  { iso2: 'BT', name: 'Bhutan', dial: '975' },
  { iso2: 'MV', name: 'Maldives', dial: '960' },
  { iso2: 'AF', name: 'Afghanistan', dial: '93' },
  { iso2: 'KZ', name: 'Kazakhstan', dial: '7' },
  { iso2: 'UZ', name: 'Uzbekistan', dial: '998' },
  { iso2: 'KG', name: 'Kyrgyzstan', dial: '996' },
  { iso2: 'TJ', name: 'Tajikistan', dial: '992' },
  { iso2: 'TM', name: 'Turkmenistan', dial: '993' },
  { iso2: 'AZ', name: 'Azerbaijan', dial: '994' },
  { iso2: 'GE', name: 'Georgia', dial: '995' },
  { iso2: 'AM', name: 'Armenia', dial: '374' },
  // --- East + South-East Asia ----------------------------------------------------
  { iso2: 'CN', name: 'China', dial: '86' },
  { iso2: 'HK', name: 'Hong Kong', dial: '852' },
  { iso2: 'MO', name: 'Macau', dial: '853' },
  { iso2: 'TW', name: 'Taiwan', dial: '886' },
  { iso2: 'JP', name: 'Japan', dial: '81' },
  { iso2: 'KR', name: 'South Korea', dial: '82' },
  { iso2: 'KP', name: 'North Korea', dial: '850' },
  { iso2: 'MN', name: 'Mongolia', dial: '976' },
  { iso2: 'SG', name: 'Singapore', dial: '65' },
  { iso2: 'MY', name: 'Malaysia', dial: '60' },
  { iso2: 'TH', name: 'Thailand', dial: '66' },
  { iso2: 'VN', name: 'Vietnam', dial: '84' },
  { iso2: 'PH', name: 'Philippines', dial: '63' },
  { iso2: 'ID', name: 'Indonesia', dial: '62' },
  { iso2: 'BN', name: 'Brunei', dial: '673' },
  { iso2: 'KH', name: 'Cambodia', dial: '855' },
  { iso2: 'LA', name: 'Laos', dial: '856' },
  { iso2: 'MM', name: 'Myanmar', dial: '95' },
  { iso2: 'TL', name: 'Timor-Leste', dial: '670' },
  // --- Oceania -------------------------------------------------------------------
  { iso2: 'AU', name: 'Australia', dial: '61' },
  { iso2: 'CX', name: 'Christmas Island', dial: '61' },
  { iso2: 'CC', name: 'Cocos Islands', dial: '61' },
  { iso2: 'NZ', name: 'New Zealand', dial: '64' },
  { iso2: 'NF', name: 'Norfolk Island', dial: '672' },
  { iso2: 'PG', name: 'Papua New Guinea', dial: '675' },
  { iso2: 'SB', name: 'Solomon Islands', dial: '677' },
  { iso2: 'VU', name: 'Vanuatu', dial: '678' },
  { iso2: 'FJ', name: 'Fiji', dial: '679' },
  { iso2: 'NC', name: 'New Caledonia', dial: '687' },
  { iso2: 'PF', name: 'French Polynesia', dial: '689' },
  { iso2: 'WF', name: 'Wallis and Futuna', dial: '681' },
  { iso2: 'WS', name: 'Samoa', dial: '685' },
  { iso2: 'TO', name: 'Tonga', dial: '676' },
  { iso2: 'KI', name: 'Kiribati', dial: '686' },
  { iso2: 'TV', name: 'Tuvalu', dial: '688' },
  { iso2: 'NR', name: 'Nauru', dial: '674' },
  { iso2: 'PW', name: 'Palau', dial: '680' },
  { iso2: 'FM', name: 'Micronesia', dial: '691' },
  { iso2: 'MH', name: 'Marshall Islands', dial: '692' },
  { iso2: 'CK', name: 'Cook Islands', dial: '682' },
  { iso2: 'NU', name: 'Niue', dial: '683' },
  { iso2: 'TK', name: 'Tokelau', dial: '690' },
  // --- Indian Ocean / Atlantic territories -----------------------------------------
  { iso2: 'IO', name: 'British Indian Ocean Territory', dial: '246' },
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
  america: 'US',
  uae: 'AE',
  'czech republic': 'CZ',
  'south korea': 'KR',
  korea: 'KR',
  'republic of korea': 'KR',
  'republic of ireland': 'IE',
  türkiye: 'TR',
  turkiye: 'TR',
  'ivory coast': 'CI',
  "côte d'ivoire": 'CI',
  'cabo verde': 'CV',
  'democratic republic of the congo': 'CD',
  'congo-kinshasa': 'CD',
  drc: 'CD',
  'congo-brazzaville': 'CG',
  'republic of the congo': 'CG',
  swaziland: 'SZ',
  burma: 'MM',
  'east timor': 'TL',
  macedonia: 'MK',
  'palestinian territories': 'PS',
  'vatican city state': 'VA',
  'holy see': 'VA',
  curaçao: 'CW',
  réunion: 'RE',
  'são tomé and príncipe': 'ST',
  'st helena': 'SH',
  'st kitts and nevis': 'KN',
  'st lucia': 'LC',
  'st vincent and the grenadines': 'VC',
  'st martin': 'MF',
  'st barthélemy': 'BL',
  'st pierre and miquelon': 'PM',
  'the bahamas': 'BS',
  'the gambia': 'GM',
  'hong kong sar': 'HK',
  macao: 'MO',
  'viet nam': 'VN',
  "lao people's democratic republic": 'LA',
  'brunei darussalam': 'BN',
  'russian federation': 'RU',
  'syrian arab republic': 'SY',
  'iran, islamic republic of': 'IR',
  'tanzania, united republic of': 'TZ',
  'bolivia, plurinational state of': 'BO',
  'venezuela, bolivarian republic of': 'VE',
  'moldova, republic of': 'MD',
  'micronesia, federated states of': 'FM',
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
// Countries where the national trunk '0' is retained after the dial code in the
// international (E.164) number rather than dropped. Italy is the canonical case
// (`+39 06…`); nearly everyone else drops it.
const TRUNK_ZERO_RETAINED: ReadonlySet<string> = new Set<string>(['IT'])

export function composePhoneE164(country: DialCountry, rawNumber: string): string | null {
  let digits = rawNumber.replace(/[^\d]/gu, '')
  if (!digits) return null
  // Already includes the dial code (typed "0051 …" / "51 928 …").
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.startsWith(country.dial) && digits.length >= country.dial.length + 7) {
    const candidate = `+${digits}`
    if (/^\+[1-9]\d{6,14}$/u.test(candidate)) return candidate
  }
  // National format: strip a single trunk 0, prepend the dial code — EXCEPT
  // for countries where the leading 0 is part of the international number
  // (Italy: `+39 06…`). Stripping it there yields a wrong, undialable E.164.
  const national =
    digits.startsWith('0') && !TRUNK_ZERO_RETAINED.has(country.iso2)
      ? digits.slice(1)
      : digits
  if (national.length < 6 || national.length > 12) return null
  const candidate = `+${country.dial}${national}`
  return /^\+[1-9]\d{6,14}$/u.test(candidate) ? candidate : null
}

// ITU dial codes form a prefix code (no code is a prefix of another), so at
// most one entry can match — still checked longest-first for clarity.
const DIAL_PREFIXES_DESC: readonly string[] = [...new Set(DIAL_COUNTRIES.map((c) => c.dial))].sort(
  (a, b) => b.length - a.length || a.localeCompare(b),
)

/**
 * Infer E.164 from a number typed WITH its dial code but no "+"/"00"
 * ("51 928 812 118" → "+51928812118") when we have no country at all (no form
 * field, IP geo failed). Deliberately strict — total 11–15 digits and 8–12
 * after the dial code — so a 9–10 digit national number can never be misread
 * as international. UK shapes are handled earlier in normalisePhone.
 */
export function inferPhoneE164(rawNumber: string): string | null {
  let digits = rawNumber.replace(/[^\d]/gu, '')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length < 11 || digits.length > 15 || digits.startsWith('0')) return null
  for (const dial of DIAL_PREFIXES_DESC) {
    if (!digits.startsWith(dial)) continue
    const rest = digits.length - dial.length
    if (rest < 8 || rest > 12) continue
    const candidate = `+${digits}`
    if (/^\+[1-9]\d{6,14}$/u.test(candidate)) return candidate
  }
  return null
}

/**
 * Resolve the country from a phone number that already carries its dial code
 * — a fully free, deterministic signal we use to fill `Contact.country` /
 * `Lead.countryCode` when the form had no country and IP geo failed. A
 * "+51928812118" unambiguously means Peru; a "+44…" means the UK. Only fires
 * on an E.164-shaped number (leading "+" or "00") so a UK national "07…" is
 * never misread. Longest dial-prefix wins (ITU codes are a prefix code, so at
 * most one matches). Note +1 maps to US among NANP countries — acceptable for
 * country display + dial-code purposes.
 */
export function dialCountryFromPhone(rawNumber: string | null | undefined): DialCountry | null {
  if (!rawNumber) return null
  const trimmed = rawNumber.trim()
  let digits = trimmed.replace(/[^\d]/gu, '')
  const international = trimmed.startsWith('+') || digits.startsWith('00')
  if (!international) return null
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (digits.length < 8 || digits.length > 15) return null
  for (const dial of DIAL_PREFIXES_DESC) {
    if (digits.startsWith(dial) && digits.length - dial.length >= 6) {
      const hit = DIAL_COUNTRIES.find((c) => c.dial === dial)
      if (hit) return hit
    }
  }
  return null
}

/**
 * Last resort when no E.164 could be derived by any route: the digits as
 * typed (leading + preserved), so the number still lands on the contact's
 * phone field — visible and manually dialable — instead of only in notes.
 * Rejects anything that can't plausibly be a phone number at all.
 */
export function asTypedPhoneFallback(rawNumber: string): string | null {
  const keptPlus = rawNumber.trim().startsWith('+')
  const digits = rawNumber.replace(/[^\d]/gu, '')
  if (digits.length < 6 || digits.length > 16) return null
  return keptPlus ? `+${digits}` : digits
}
