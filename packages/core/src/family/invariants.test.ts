// Property-based invariant tests for §41.1 Family invariants.
// Generators try to violate each invariant deliberately. Deterministic seed
// so failures pinpoint the case.

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  checkBillingContactNotStudent,
  checkContactPhoneUniqueness,
  checkOneBillingContact,
  checkRestrictedAccessAssigneeIsDsl,
  checkStudentMinorBelongsToFamily,
  type FamilyMemberLink,
} from './invariants'

const SEED = 1714867200000 // deterministic across runs

const memberRole = fc.constantFrom<FamilyMemberLink['role']>(
  'billing',
  'student',
  'guardian',
  'other',
)
const contactId = fc.uuid()

describe('§41.1 Family invariants — property-based', () => {
  it('checkOneBillingContact: a Family with members must have a billing contact', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasMembers, hasBilling) => {
        const r = checkOneBillingContact(hasBilling ? 'b1' : null, hasMembers)
        if (hasMembers && !hasBilling) {
          expect(r.ok).toBe(false)
          expect(r.ok ? null : r.code).toBe('FAMILY_NO_BILLING_CONTACT')
        } else {
          expect(r.ok).toBe(true)
        }
      }),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkBillingContactNotStudent: never legal to list billing contact as student', () => {
    const memberArb = fc.record({ contactId, role: memberRole })
    fc.assert(
      fc.property(
        fc.option(contactId, { nil: null }),
        fc.array(memberArb, { maxLength: 6 }),
        (billing, members) => {
          const r = checkBillingContactNotStudent(billing, members)
          const violates =
            billing !== null &&
            members.some((m) => m.contactId === billing && m.role === 'student')
          expect(r.ok).toBe(!violates)
        },
      ),
      { seed: SEED, numRuns: 300 },
    )
  })

  it('checkBillingContactNotStudent: synthetic violator is detected', () => {
    fc.assert(
      fc.property(contactId, (id) => {
        const r = checkBillingContactNotStudent(id, [{ contactId: id, role: 'student' }])
        expect(r.ok).toBe(false)
      }),
      { seed: SEED, numRuns: 50 },
    )
  })

  it('checkStudentMinorBelongsToFamily: minor + bookings + no family fails', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        memberRole,
        fc.option(fc.uuid(), { nil: null }),
        fc.boolean(),
        (isMinor, role, familyId, hasBookings) => {
          const r = checkStudentMinorBelongsToFamily({
            isMinor,
            role,
            familyId,
            hasBookings,
          })
          const violates =
            role === 'student' && isMinor && familyId === null && hasBookings
          expect(r.ok).toBe(!violates)
        },
      ),
      { seed: SEED, numRuns: 300 },
    )
  })

  it('checkRestrictedAccessAssigneeIsDsl: any non-(dsl|admin|null) assignee fails', () => {
    const role = fc.constantFrom<
      'admin' | 'ops_manager' | 'agent' | 'finance' | 'dsl' | 'read_only' | null
    >('admin', 'ops_manager', 'agent', 'finance', 'dsl', 'read_only', null)
    fc.assert(
      fc.property(fc.boolean(), role, (restricted, assigneeRole) => {
        const r = checkRestrictedAccessAssigneeIsDsl({ restricted, assigneeRole })
        const violates =
          restricted &&
          assigneeRole !== null &&
          assigneeRole !== 'dsl' &&
          assigneeRole !== 'admin'
        expect(r.ok).toBe(!violates)
      }),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkContactPhoneUniqueness: same phone across different families fails', () => {
    const r = checkContactPhoneUniqueness([
      { contactId: 'c1', phoneE164: '+447700900001', familyIdsShared: ['fA'] },
      { contactId: 'c2', phoneE164: '+447700900001', familyIdsShared: ['fB'] },
    ])
    expect(r.ok).toBe(false)
  })

  it('checkContactPhoneUniqueness: same phone within shared Family is allowed', () => {
    const r = checkContactPhoneUniqueness([
      { contactId: 'c1', phoneE164: '+447700900001', familyIdsShared: ['fA'] },
      { contactId: 'c2', phoneE164: '+447700900001', familyIdsShared: ['fA'] },
    ])
    expect(r.ok).toBe(true)
  })

  it('checkContactPhoneUniqueness: distinct phones never violate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.uuid(), fc.string({ minLength: 3, maxLength: 16 })), {
          minLength: 1,
          maxLength: 8,
        }),
        (rows) => {
          const seen = new Set<string>()
          const phones = new Set<string>()
          const synthetic = rows
            .filter(([id, ph]) => {
              if (seen.has(id)) return false
              if (phones.has(ph)) return false
              seen.add(id)
              phones.add(ph)
              return true
            })
            .map(([id, ph]) => ({
              contactId: id,
              phoneE164: ph,
              familyIdsShared: ['shared-everyone'] as const,
            }))
          const r = checkContactPhoneUniqueness(synthetic)
          expect(r.ok).toBe(true)
        },
      ),
      { seed: SEED, numRuns: 100 },
    )
  })
})
