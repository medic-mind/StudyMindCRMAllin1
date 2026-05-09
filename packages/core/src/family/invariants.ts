// Family domain invariants. Pure functions; CLAUDE.md §41.1.
//
// Each invariant is a `check…` function that returns `{ ok: true }` or
// `{ ok: false, code, message }`. Existing imperative helpers in `rules.ts`
// throw BusinessError; the invariants here are the canonical, testable
// statement of the rule and are exercised by property-based tests.

export interface FamilyMemberLink {
  contactId: string
  role: 'billing' | 'student' | 'guardian' | 'other'
}

export interface InvariantOk {
  ok: true
}
export interface InvariantFail {
  ok: false
  code: string
  message: string
}
export type InvariantResult = InvariantOk | InvariantFail

/**
 * §41.1: a Family has exactly one billing contact at any time.
 */
export function checkOneBillingContact(
  billingContactId: string | null,
  hasMembers: boolean,
): InvariantResult {
  if (billingContactId === null && hasMembers) {
    return {
      ok: false,
      code: 'FAMILY_NO_BILLING_CONTACT',
      message: 'A Family with members must have a billing contact',
    }
  }
  return { ok: true }
}

/**
 * §41.1: a student under 18 must belong to a Family before any Booking
 * can attach. Inputs encode the at-link-time check.
 */
export function checkStudentMinorBelongsToFamily(input: {
  isMinor: boolean
  role: FamilyMemberLink['role']
  familyId: string | null
  hasBookings: boolean
}): InvariantResult {
  if (
    input.role === 'student' &&
    input.isMinor &&
    input.familyId === null &&
    input.hasBookings
  ) {
    return {
      ok: false,
      code: 'STUDENT_MINOR_REQUIRES_FAMILY',
      message: 'A minor student with bookings must belong to a Family',
    }
  }
  return { ok: true }
}

/**
 * §41.1: a Contact cannot be both the billing contact and a student of
 * the same Family.
 */
export function checkBillingContactNotStudent(
  billingContactId: string | null,
  members: ReadonlyArray<FamilyMemberLink>,
): InvariantResult {
  if (!billingContactId) return { ok: true }
  const isStudent = members.some(
    (m) => m.contactId === billingContactId && m.role === 'student',
  )
  if (isStudent) {
    return {
      ok: false,
      code: 'BILLING_CONTACT_IS_STUDENT',
      message: 'Billing contact cannot also be a student of the same Family',
    }
  }
  return { ok: true }
}

/**
 * §41.1: a Contact flagged restricted_access cannot be assigned to a
 * non-DSL user.
 */
export function checkRestrictedAccessAssigneeIsDsl(input: {
  restricted: boolean
  assigneeRole: 'admin' | 'ops_manager' | 'agent' | 'finance' | 'dsl' | 'read_only' | null
}): InvariantResult {
  if (!input.restricted) return { ok: true }
  if (input.assigneeRole === null) return { ok: true } // unassigned is valid
  if (input.assigneeRole !== 'dsl' && input.assigneeRole !== 'admin') {
    return {
      ok: false,
      code: 'RESTRICTED_ASSIGNEE_NOT_DSL',
      message: 'Restricted contacts may only be assigned to a DSL or admin',
    }
  }
  return { ok: true }
}

/**
 * §41.1: an E.164 phone number is unique per Contact, but may legitimately
 * repeat across a Family (shared landline). The invariant fails when two
 * different Contact rows share the same number — and there is no Family
 * grouping that legitimises it.
 */
export interface ContactPhoneRow {
  contactId: string
  phoneE164: string
  familyIdsShared: ReadonlyArray<string> // families both contacts belong to
}

export function checkContactPhoneUniqueness(
  rows: ReadonlyArray<ContactPhoneRow>,
): InvariantResult {
  // Group by phone.
  const byPhone = new Map<string, ContactPhoneRow[]>()
  for (const r of rows) {
    const arr = byPhone.get(r.phoneE164) ?? []
    arr.push(r)
    byPhone.set(r.phoneE164, arr)
  }
  for (const [phone, group] of byPhone) {
    if (group.length === 1) continue
    // All contacts sharing the number must share at least one Family.
    const intersection = group.reduce<Set<string> | null>((acc, r) => {
      const set = new Set(r.familyIdsShared)
      if (acc === null) return set
      const next = new Set<string>()
      for (const x of acc) if (set.has(x)) next.add(x)
      return next
    }, null)
    if (!intersection || intersection.size === 0) {
      return {
        ok: false,
        code: 'CONTACT_PHONE_DUPLICATED_ACROSS_FAMILIES',
        message: `Phone ${phone} is shared across Contacts not in the same Family`,
      }
    }
  }
  return { ok: true }
}
