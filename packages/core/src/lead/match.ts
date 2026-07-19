// Contact matching + re-enquiry dedupe decisions (ADR 0023, automated in
// ADR 0044).
//
// Pure: the job runs the DB queries and feeds the candidates in; this decides
// what to do. The operator's direction (2026-07) is FULL automation — no lead
// waits for a human:
//   - several contacts sharing the email/phone → attach the enquiry to the
//     most recently active one (the caller passes candidates most-recent
//     first), stamped `ambiguousResolved` so the guess is visible + auditable.
//     This annotates a contact — it never merges records (CLAUDE.md §41.1).
//   - no email/phone but a name → onboard (or attach on a UNIQUE name match).
//   - nothing at all to key on (no name, no email, no phone) → discard as
//     junk; there is nobody to contact, so a tray row would be a dead end.

const HOUR_MS = 60 * 60 * 1000

export interface ContactCandidate {
  id: string
}

export interface MatchDecision {
  contactId: string | null
  reason: string
  /** True when several contacts matched and we attached to the most recently
   *  active one instead of parking (ADR 0044). Recorded on the enquiry so the
   *  auto-pick is reviewable. */
  ambiguousResolved: boolean
}

export function chooseContactMatch(input: {
  email: string | null
  phoneE164: string | null
  /** Candidates MUST be ordered most-recently-active first — the auto-pick
   *  takes the head of the list. */
  byEmail: ContactCandidate[]
  byPhone: ContactCandidate[]
  /** Exact-name candidates, consulted only when email/phone found nothing.
   *  A unique name attaches; two same-named people never auto-attach. */
  byName?: ContactCandidate[]
}): MatchDecision {
  if (input.email && input.byEmail.length === 1) {
    return { contactId: input.byEmail[0]!.id, reason: 'matched by email', ambiguousResolved: false }
  }
  if (input.email && input.byEmail.length > 1) {
    return {
      contactId: input.byEmail[0]!.id,
      reason: 'several contacts share this email — attached to the most recently active',
      ambiguousResolved: true,
    }
  }
  if (input.phoneE164 && input.byPhone.length === 1) {
    return { contactId: input.byPhone[0]!.id, reason: 'matched by phone', ambiguousResolved: false }
  }
  if (input.phoneE164 && input.byPhone.length > 1) {
    return {
      contactId: input.byPhone[0]!.id,
      reason: 'phone shared across contacts — attached to the most recently active',
      ambiguousResolved: true,
    }
  }
  const byName = input.byName ?? []
  if (byName.length === 1) {
    return { contactId: byName[0]!.id, reason: 'matched by name', ambiguousResolved: false }
  }
  // Two same-named contacts: a fresh contact is reversible; a wrong attach
  // puts a customer's enquiry on a stranger's timeline. Create, don't guess.
  return { contactId: null, reason: 'no existing contact matched', ambiguousResolved: false }
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
 * The whole routing decision for a classified web lead (ADR 0044 — fully
 * automatic, nothing waits for a human):
 * - existing contact (incl. an auto-resolved shared email/phone, or a unique
 *   name match) → re-enquiry; fresh card only if >24h since the last enquiry.
 * - anything identifiable (email, phone, or just a name) → onboard.
 * - nothing to key on at all → discard as junk (auto-dismissed, kept on the
 *   Lead log; never a tray dead-end).
 * Pure so the behaviour is locked by unit tests.
 */
export type LeadRoutingPlan =
  | { kind: 'onboard' }
  | { kind: 'reenquiry'; contactId: string; createCard: boolean; ambiguousResolved: boolean }
  | { kind: 'discard'; reason: string }

export function planLeadRouting(input: {
  hasContactInfo: boolean
  /** The form carried a usable person name — enough to onboard on its own. */
  hasName: boolean
  match: MatchDecision
  lastEnquiryAt: Date | null
  now: Date
  windowHours?: number
}): LeadRoutingPlan {
  if (input.match.contactId) {
    return {
      kind: 'reenquiry',
      contactId: input.match.contactId,
      createCard: shouldCreateCardOnReenquiry(input.lastEnquiryAt, input.now, input.windowHours),
      ambiguousResolved: input.match.ambiguousResolved,
    }
  }
  if (input.hasContactInfo || input.hasName) {
    return { kind: 'onboard' }
  }
  return { kind: 'discard', reason: 'no name, email or phone — nothing to contact or key on' }
}
