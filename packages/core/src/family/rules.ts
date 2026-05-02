// Family invariants and rules. See CLAUDE.md Section 41.1.

import { BusinessError } from '../errors'

export interface FamilyMemberLink {
  contactId: string
  role: 'billing' | 'student' | 'guardian' | 'other'
}

/**
 * Invariant: a Contact cannot be both the billing contact and a student of the
 * same Family. Returns silently on success, throws BusinessError on violation.
 */
export function assertBillingContactNotStudent(
  billingContactId: string | null,
  members: ReadonlyArray<FamilyMemberLink>,
): void {
  if (!billingContactId) return
  const isStudent = members.some(
    (m) => m.contactId === billingContactId && m.role === 'student',
  )
  if (isStudent) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'Billing contact cannot also be a student of the same Family',
      { billingContactId },
    )
  }
}

/**
 * Invariant: a Family has exactly one billing contact at any time. Switching it
 * is the caller's responsibility — this helper rejects an attempt to clear the
 * billing contact on a Family that has any active members.
 */
export function assertBillingContactPresent(
  billingContactId: string | null,
  hasMembers: boolean,
): void {
  if (!billingContactId && hasMembers) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'A Family with members must have a billing contact',
    )
  }
}
