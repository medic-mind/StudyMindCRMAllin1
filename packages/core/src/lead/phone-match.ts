// Format-insensitive phone matching for contact dedupe (ADR 0023, §41.1).
//
// The dedupe bug: a first enquiry could store a phone in one shape
// ("928812118" — a national number with no resolvable country) while a later
// re-enquiry, once a country resolves, composes the SAME number to E.164
// ("+51928812118"). An exact-string match then misses and a DUPLICATE contact
// is created. We match on every candidate form AND on the last-9-digit suffix
// (the same key the missed-calls workspace uses), so the two shapes converge.
//
// Pure: the job runs the DB query from this; never auto-merges (>1 hit is
// ambiguous → triage, §41.1).

export interface PhoneMatchQuery {
  /** Exact forms to match against Contact.phoneE164 (deduped). */
  exact: string[]
  /** Last-9-digit suffix for a format-insensitive `endsWith` match, or null
   *  when no form carries enough digits to be a real number. */
  suffix: string | null
}

/**
 * Build the phone-match query from every candidate form a lead produced
 * (the form's E.164, the country-composed E.164, the dial-code-inferred
 * E.164, the as-typed fallback). The suffix is the last 9 digits of the
 * first form with ≥9 digits — stable across spaces, the +44/0 trunk, and the
 * country code, so "928812118" and "+51928812118" share suffix "928812118".
 */
export function buildPhoneMatch(
  forms: ReadonlyArray<string | null | undefined>,
): PhoneMatchQuery {
  const exact = Array.from(
    new Set(forms.filter((f): f is string => typeof f === 'string' && f.trim() !== '')),
  )
  let suffix: string | null = null
  for (const f of exact) {
    const digits = f.replace(/\D/gu, '')
    if (digits.length >= 9) {
      suffix = digits.slice(-9)
      break
    }
  }
  return { exact, suffix }
}
