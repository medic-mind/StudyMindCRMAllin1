// Phone-aware search-query interpretation, shared by every surface that lets
// staff type a number into a search box (global ⌘K search, the Contacts table,
// contact typeaheads). Staff type numbers the way humans do — "07818 953024",
// "+44 7818-953024", "7818953024" — while the column stores E.164 (§29), so a
// literal `contains` on the raw query can never match. This turns a
// phone-shaped query into the digit runs to `contains`-match against
// `Contact.phoneE164`, tolerant of separators, a missing country code, the
// UK trunk 0, and legacy as-typed rows (bare digits / 0-led).
//
// Pure and dependency-free — the DB condition assembly stays at the caller.

/** Minimum digits before a query is treated as a phone search — shorter runs
 *  ("2024", a house number) are far more often not a phone. */
const MIN_PHONE_QUERY_DIGITS = 5

/**
 * The digit substrings to `contains`-match against stored phone values, or an
 * empty array when the query is not phone-shaped (letters present, or too few
 * digits). Runs are longest-first and deduplicated; every run is ≥5 digits.
 *
 *   "07818 953024"    → ["07818953024", "7818953024"]
 *   "+44 7818 953024" → ["447818953024", "7818953024"]
 *   "0044 7818953024" → ["00447818953024", "447818953024", "7818953024"]
 */
export function phoneSearchDigitRuns(q: string): string[] {
  const compact = q.replace(/[\s().-]/gu, '')
  if (!/^\+?\d+$/u.test(compact)) return []
  const digits = compact.replace(/^\+/u, '')
  if (digits.length < MIN_PHONE_QUERY_DIGITS || digits.length > 18) return []

  const runs = new Set<string>([digits])
  // International-prefix / trunk-zero forms: 00 44…, 0…, +44 0…
  const noLeadingZeros = digits.replace(/^0+/u, '')
  runs.add(noLeadingZeros)
  // UK country code typed out (44… / 440…): also try the national significant
  // number, so "44 7818…" finds a legacy "07818…" row and vice versa (§29 —
  // the CRM is UK-centric; other codes still match via the full-digit run).
  if (noLeadingZeros.startsWith('44') && noLeadingZeros.length >= 11) {
    runs.add(noLeadingZeros.slice(2).replace(/^0+/u, ''))
  }

  return [...runs].filter((r) => r.length >= MIN_PHONE_QUERY_DIGITS)
}
