// Pure detection of Summer Camp / Work Experience purchases from Stripe
// product text (CLAUDE.md §37 summer-camp row). Deliberately conservative:
// only the two operator-named phrase families match — a generic "camp" or
// "experience day" never does. The caller (stripe charge.succeeded pipeline)
// feeds it the charge's description + statement descriptor + metadata.

export type CampPurchaseKeyword = 'summer_camp' | 'work_experience'

export interface CampPurchaseDetection {
  matched: boolean
  keyword: CampPurchaseKeyword | null
}

// "summer camp", "summercamp", "summer-camp" (any whitespace/hyphen run).
const SUMMER_CAMP_RE = /summer[\s-]*camp/i
// "work experience", "work-experience", "workexperience".
const WORK_EXPERIENCE_RE = /work[\s-]*experience/i

export function detectCampPurchase(productText: string | null | undefined): CampPurchaseDetection {
  const text = (productText ?? '').trim()
  if (!text) return { matched: false, keyword: null }
  if (SUMMER_CAMP_RE.test(text)) return { matched: true, keyword: 'summer_camp' }
  if (WORK_EXPERIENCE_RE.test(text)) return { matched: true, keyword: 'work_experience' }
  return { matched: false, keyword: null }
}

/** Human label for a matched keyword (used as the booking subject fallback). */
export function keywordLabel(keyword: CampPurchaseKeyword): string {
  return keyword === 'summer_camp' ? 'Summer Camp' : 'Work Experience'
}

/** Split a Stripe billing name ("Jane Smith") into first/last for the camp
 *  booking. Single-token names become first name + a placeholder surname the
 *  team corrects in triage (the camp app requires both). */
export function splitBillingName(name: string | null | undefined): {
  firstName: string
  lastName: string
} | null {
  const trimmed = (name ?? '').trim()
  if (!trimmed) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { firstName: parts[0]!, lastName: '(unknown)' }
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') }
}
