// Lead phone + country resolution (ADR 0023 follow-up — international fix).
//
// The single place that decides (a) the enquirer's country and (b) the final
// E.164 phone, from the strongest available signal down to the weakest. The
// ordering is the fix for the "99.5% of international numbers are invalid" bug:
//
//   1. the form's own COUNTRY field                — the enquirer selected it
//   2. the phone's OWN dial code                   — the enquirer typed it
//   3. a form-forwarded VISITOR IP                 — the enquirer's real IP
//   4. the AI's inferred country                   — reads the enquiry content
//   5. the TRANSPORT IP (last resort)              — usually the WORDPRESS HOST
//
// Why (5) is last: a Contact-Form-7 webhook is POSTed by the WordPress server,
// so the transport IP is the site's host (a UK box for a UK company), NOT the
// enquirer. Geolocating it returned "GB" for basically every overseas lead,
// which then (i) composed every national number as "+44…" (invalid) and
// (ii) pre-empted the two signals that would have been correct — the phone's
// own country code and the AI. Both now rank above it. A customer-given country
// code always wins (CLAUDE.md §16).

import {
  asTypedPhoneFallback,
  composePhoneE164,
  dialCountryFromCode,
  dialCountryFromPhone,
  findDialCountry,
  inferPhoneE164,
  type DialCountry,
} from './dial-codes'

export type LeadCountrySource = 'form' | 'phone_dial' | 'visitor_ip' | 'ai' | 'transport_ip'

export interface ResolvePhoneCountryInput {
  /** The form's country field (name or ISO2), if any — `NormalisedLead.country`. */
  formCountry: string | null
  /** The phone exactly as typed — `NormalisedLead.phone`. */
  phoneDisplay: string | null
  /** The E.164 normalisePhone produced (may be a GUESSED +44) — `phoneE164`. */
  phoneE164: string | null
  /** 'GB' when the E.164 was a GUESS (a bare 0…/7… national number optimistically
   *  mapped to +44) rather than an explicitly international number. */
  phoneAssumedCountry: 'GB' | null
  /** The AI's best-guess ISO2 country, if enrichment ran. */
  aiCountryCode: string | null
  /** A visitor IP the FORM forwarded (`NormalisedLead.clientIp`) — the enquirer's
   *  own IP, so it is trustworthy. Null when the form did not forward it. */
  visitorIp: string | null
  /** The transport IP captured at the endpoint (`Lead.ip`). For a server-side
   *  CF7 webhook this is usually the WordPress host, so it is the last resort. */
  transportIp: string | null
}

export interface ResolvePhoneCountryResult {
  /** The final phone in E.164 (or as-typed digits when nothing could compose),
   *  or null when there was no phone at all. */
  phoneE164: string | null
  /** The resolved country (drives `Contact.country` + composing a bare number). */
  country: DialCountry | null
  /** Which signal won — for logging / auditing the decision. */
  countrySource: LeadCountrySource | null
}

/**
 * Resolve the enquirer's country and final E.164 phone. `geoCountry` is injected
 * (the pure core stays network-free); it maps an IP → ISO2 and may be omitted in
 * tests. Any geo failure/null simply falls through to the next signal.
 */
export async function resolveLeadPhoneAndCountry(
  input: ResolvePhoneCountryInput,
  geoCountry?: (ip: string) => Promise<string | null>,
): Promise<ResolvePhoneCountryResult> {
  // The phone's OWN country code is definitive — the customer stated it. An
  // explicit "+…" / "00…" / bare "44…" is already E.164; a dial code typed
  // without the "+" ("91 98765 43210") is recovered by inferPhoneE164. A
  // GUESSED +44 (assumedCountry === 'GB') is NOT definitive and is excluded.
  const explicitE164 = input.phoneAssumedCountry === 'GB' ? null : input.phoneE164
  const ownCodeE164 =
    explicitE164 ?? (input.phoneDisplay ? inferPhoneE164(input.phoneDisplay) : null)

  // --- Country waterfall (customer-given signals beat guesses) ---------------
  // The form's country field may be a NAME/ISO2 ("United Kingdom", "GB") OR a
  // dial code ("+44", "+964") — CF7's "Country code" field posts the latter.
  // Try the name/ISO resolver first, then the dial-code resolver, so a
  // customer-stated dial code is honoured instead of being lost to IP geo.
  let country: DialCountry | null =
    findDialCountry(input.formCountry) ?? dialCountryFromCode(input.formCountry)
  let countrySource: LeadCountrySource | null = country ? 'form' : null

  if (!country && ownCodeE164) {
    country = dialCountryFromPhone(ownCodeE164)
    if (country) countrySource = 'phone_dial'
  }
  if (!country && input.visitorIp && geoCountry) {
    country = findDialCountry(await geoCountry(input.visitorIp))
    if (country) countrySource = 'visitor_ip'
  }
  if (!country && input.aiCountryCode) {
    country = findDialCountry(input.aiCountryCode)
    if (country) countrySource = 'ai'
  }
  if (
    !country &&
    input.transportIp &&
    geoCountry &&
    input.transportIp !== input.visitorIp
  ) {
    country = findDialCountry(await geoCountry(input.transportIp))
    if (country) countrySource = 'transport_ip'
  }

  // --- Compose the final E.164 ----------------------------------------------
  // The phone's own code always wins. Otherwise compose a bare national number
  // with the resolved country — but NEVER rewrite a guessed +44 off the back of
  // the transport IP (the WordPress host says nothing about the enquirer): keep
  // the +44 guess instead. Then infer a stray dial code, then store as typed so
  // the number is never silently lost.
  let phoneE164: string | null = ownCodeE164
  if (!phoneE164 && input.phoneDisplay && country) {
    const guessedUkOnHostIp =
      input.phoneAssumedCountry === 'GB' && countrySource === 'transport_ip'
    if (!guessedUkOnHostIp) phoneE164 = composePhoneE164(country, input.phoneDisplay)
  }
  if (!phoneE164 && input.phoneAssumedCountry === 'GB' && input.phoneE164) {
    phoneE164 = input.phoneE164
  }
  if (!phoneE164 && input.phoneDisplay) phoneE164 = inferPhoneE164(input.phoneDisplay)
  if (!phoneE164 && input.phoneDisplay) phoneE164 = asTypedPhoneFallback(input.phoneDisplay)

  return { phoneE164, country, countrySource }
}
