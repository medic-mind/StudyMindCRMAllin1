// Retroactive phone-number repair (the "fix the numbers already on the Invalid
// number board" tool). ADR 0023 follow-up.
//
// The live bug (fixed forward in phone-country.ts + dial-codes.ts) mangled web
// enquiries whose CF7 form posted a "Country code: +44" / "+964" field: the
// dial code wasn't recognised, so the number was composed against a wrongly
// IP-geolocated host country (+44 → +49…, +964 → +359…). Those contacts already
// carry a *valid-looking but wrong* +… number, so the existing
// `lead/backfill-countries` maintenance job — which only upgrades non-"+"
// as-typed numbers and never overwrites an existing E.164 (§3) — correctly
// leaves them alone.
//
// This module re-derives the number from the enquirer's OWN original submission
// (`Lead.rawPayload`, which still contains their stated country code) using the
// CORRECTED resolver, and proposes a correction ONLY when the new number comes
// from a customer-stated signal (the form country field or the phone's own dial
// code) and actually differs. It is pure + deterministic (no IP geo, no AI), so
// it never re-introduces a guess — an operator triggers it and sees a preview
// (§3/§34).

import type { RawLeadInput } from './normalise'
import { normaliseLead } from './normalise'
import { resolveLeadPhoneAndCountry } from './phone-country'

const E164_RE = /^\+[1-9]\d{6,14}$/u

export interface PhoneRepairProposal {
  /** The number currently stored on the contact (the wrong one), if any. */
  currentPhoneE164: string | null
  /** The corrected E.164 re-derived from the original enquiry. */
  proposedPhoneE164: string
  /** The resolved country's English name (for filling a blank Contact.country). */
  proposedCountry: string | null
  /** Which customer-stated signal produced it — 'form' or 'phone_dial'. */
  countrySource: 'form' | 'phone_dial'
}

/** True when `value` is a shape we can re-normalise (a stored RawLeadInput). */
function isRawLeadInput(value: unknown): value is RawLeadInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fields' in value &&
    typeof (value as { fields: unknown }).fields === 'object' &&
    (value as { fields: unknown }).fields !== null
  )
}

/**
 * Re-derive the correct phone number from a lead's original stored submission
 * and, if it is a confident correction of the currently-stored number, return
 * the proposal. Returns null when:
 *   - the stored payload can't be re-normalised, or
 *   - the enquiry had no phone at all, or
 *   - the re-derivation didn't come from a customer-stated signal (form country
 *     field / the phone's own dial code) — so we never overwrite a number off
 *     the back of a mere IP/AI guess, and a plain UK national number with no
 *     country field is left untouched, or
 *   - the re-derived number isn't a valid E.164, or
 *   - it already matches what's stored (nothing to fix).
 */
export async function proposePhoneRepair(args: {
  currentPhoneE164: string | null
  rawPayload: unknown
}): Promise<PhoneRepairProposal | null> {
  if (!isRawLeadInput(args.rawPayload)) return null
  const normalised = normaliseLead(args.rawPayload)
  if (!normalised.phone && !normalised.phoneE164) return null

  // Deterministic only: no geo function, no AI country — so only the form
  // country field and the phone's own dial code can win.
  const { phoneE164, country, countrySource } = await resolveLeadPhoneAndCountry({
    formCountry: normalised.country,
    phoneDisplay: normalised.phone,
    phoneE164: normalised.phoneE164,
    phoneAssumedCountry: normalised.phoneAssumedCountry,
    aiCountryCode: null,
    visitorIp: null,
    transportIp: null,
  })

  if (countrySource !== 'form' && countrySource !== 'phone_dial') return null
  if (!phoneE164 || !E164_RE.test(phoneE164)) return null
  if (phoneE164 === args.currentPhoneE164) return null

  return {
    currentPhoneE164: args.currentPhoneE164,
    proposedPhoneE164: phoneE164,
    proposedCountry: country?.name ?? null,
    countrySource,
  }
}
