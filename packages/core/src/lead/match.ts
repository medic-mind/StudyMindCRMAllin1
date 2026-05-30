// Contact matching + re-enquiry dedupe decisions (ADR 0023).
//
// Pure: the job runs the DB queries and feeds the candidates in; this decides
// what to do. Conservative by design — we never auto-merge (CLAUDE.md §41.1),
// so an email shared by several contacts, or a phone on a shared family line,
// is treated as "no confident match" rather than a guess.

const HOUR_MS = 60 * 60 * 1000

export interface ContactCandidate {
  id: string
}

export interface MatchDecision {
  contactId: string | null
  reason: string
  /** True when we found candidates but could not safely pick one. */
  ambiguous: boolean
}

export function chooseContactMatch(input: {
  email: string | null
  phoneE164: string | null
  byEmail: ContactCandidate[]
  byPhone: ContactCandidate[]
}): MatchDecision {
  if (input.email && input.byEmail.length === 1) {
    return { contactId: input.byEmail[0]!.id, reason: 'matched by email', ambiguous: false }
  }
  if (input.email && input.byEmail.length > 1) {
    return {
      contactId: null,
      reason: 'multiple contacts share this email — needs human triage',
      ambiguous: true,
    }
  }
  if (input.phoneE164 && input.byPhone.length === 1) {
    return { contactId: input.byPhone[0]!.id, reason: 'matched by phone', ambiguous: false }
  }
  if (input.phoneE164 && input.byPhone.length > 1) {
    return {
      contactId: null,
      reason: 'phone shared across contacts (shared family line)',
      ambiguous: true,
    }
  }
  return { contactId: null, reason: 'no existing contact matched', ambiguous: false }
}

/**
 * On a re-enquiry we always annotate the existing contact. We additionally drop
 * a fresh pipeline card only when the previous enquiry was at least
 * `windowHours` ago — so a flurry of duplicate submissions inside 24h stays a
 * single card (just annotated), but renewed interest days later resurfaces on
 * the Sales Pipeline board (user requirement).
 */
export function shouldCreateCardOnReenquiry(
  lastEnquiryAt: Date | null,
  now: Date,
  windowHours = 24,
): boolean {
  if (!lastEnquiryAt) return true
  return now.getTime() - lastEnquiryAt.getTime() >= windowHours * HOUR_MS
}

/**
 * The whole routing decision for a classified web lead (the user's spec):
 * - no email AND no phone → can't match or onboard safely → tray.
 * - ambiguous match (shared email/line) → tray (never auto-merge, §41.1).
 * - existing contact → re-enquiry; drop a fresh card only if >24h since the
 *   last enquiry, otherwise just annotate the contact.
 * - otherwise → onboard a new contact + card.
 * Pure so the dedupe behaviour is locked by a unit test.
 */
export type LeadRoutingPlan =
  | { kind: 'onboard' }
  | { kind: 'reenquiry'; contactId: string; createCard: boolean }
  | { kind: 'needs_triage'; reason: string }

export function planLeadRouting(input: {
  hasContactInfo: boolean
  match: MatchDecision
  lastEnquiryAt: Date | null
  now: Date
  windowHours?: number
}): LeadRoutingPlan {
  if (!input.hasContactInfo) {
    return { kind: 'needs_triage', reason: 'no email or phone to match or onboard on' }
  }
  if (input.match.ambiguous) {
    return { kind: 'needs_triage', reason: input.match.reason }
  }
  if (input.match.contactId) {
    return {
      kind: 'reenquiry',
      contactId: input.match.contactId,
      createCard: shouldCreateCardOnReenquiry(input.lastEnquiryAt, input.now, input.windowHours),
    }
  }
  return { kind: 'onboard' }
}
