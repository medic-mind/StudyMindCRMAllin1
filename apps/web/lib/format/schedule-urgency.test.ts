import { describe, expect, it } from 'vitest'

import { scheduleUrgency } from './schedule-urgency'

describe('scheduleUrgency', () => {
  // A fixed "now": Thu 23 Jul 2026, 14:00 London (13:00 UTC in BST).
  const now = new Date('2026-07-23T13:00:00Z')

  it('flags a past time as overdue (incl. earlier the same day)', () => {
    expect(scheduleUrgency(new Date('2026-07-23T08:00:00Z'), now)).toBe('overdue')
    expect(scheduleUrgency(new Date('2026-07-20T10:00:00Z'), now)).toBe('overdue')
  })

  it('flags a later time today as today', () => {
    expect(scheduleUrgency(new Date('2026-07-23T16:00:00Z'), now)).toBe('today')
  })

  it('flags the next London day as tomorrow', () => {
    expect(scheduleUrgency(new Date('2026-07-24T08:00:00Z'), now)).toBe('tomorrow')
  })

  it('flags within a week as soon, beyond as later', () => {
    expect(scheduleUrgency(new Date('2026-07-27T09:00:00Z'), now)).toBe('soon')
    expect(scheduleUrgency(new Date('2026-08-15T09:00:00Z'), now)).toBe('later')
  })
})
