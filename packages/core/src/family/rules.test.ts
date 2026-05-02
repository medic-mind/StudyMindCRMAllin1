// Family invariant tests. CLAUDE.md §41.1.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors.js'

import { assertBillingContactNotStudent, assertBillingContactPresent } from './rules.js'

describe('assertBillingContactNotStudent', () => {
  it('passes when no billing contact is set', () => {
    expect(() =>
      assertBillingContactNotStudent(null, [{ contactId: 'c1', role: 'student' }]),
    ).not.toThrow()
  })

  it('passes when the billing contact is not a member at all', () => {
    expect(() =>
      assertBillingContactNotStudent('parent_1', [{ contactId: 'student_1', role: 'student' }]),
    ).not.toThrow()
  })

  it('passes when the billing contact is a guardian member', () => {
    expect(() =>
      assertBillingContactNotStudent('parent_1', [{ contactId: 'parent_1', role: 'guardian' }]),
    ).not.toThrow()
  })

  it('throws BusinessError when the billing contact is also a student', () => {
    expect(() =>
      assertBillingContactNotStudent('contact_1', [
        { contactId: 'contact_1', role: 'student' },
      ]),
    ).toThrow(BusinessError)
  })

  it('produces a stable BusinessError code', () => {
    try {
      assertBillingContactNotStudent('contact_1', [{ contactId: 'contact_1', role: 'student' }])
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(BusinessError)
      expect((err as BusinessError).code).toBe('INVALID_STATE_TRANSITION')
    }
  })
})

describe('assertBillingContactPresent', () => {
  it('passes when there are no members and no billing contact', () => {
    expect(() => assertBillingContactPresent(null, false)).not.toThrow()
  })

  it('throws when there are members but no billing contact', () => {
    expect(() => assertBillingContactPresent(null, true)).toThrow(BusinessError)
  })
})
