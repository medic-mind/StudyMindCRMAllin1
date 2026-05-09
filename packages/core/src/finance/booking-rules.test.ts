import { describe, expect, it } from 'vitest'

import {
  applyCorrection,
  countDeliveredHours,
  isLegalSessionTransition,
  type BookingSessionRecord,
} from './booking-rules'

function s(partial: Partial<BookingSessionRecord> & { id: string }): BookingSessionRecord {
  return {
    state: 'tentative',
    deliveredHours: 0,
    correctedSessionId: null,
    ...partial,
  }
}

describe('countDeliveredHours', () => {
  it('only counts delivered sessions', () => {
    const sessions = [
      s({ id: 'a', state: 'delivered', deliveredHours: 2 }),
      s({ id: 'b', state: 'no_show', deliveredHours: 2 }),
      s({ id: 'c', state: 'cancelled', deliveredHours: 2 }),
      s({ id: 'd', state: 'tentative', deliveredHours: 2 }),
      s({ id: 'e', state: 'confirmed', deliveredHours: 2 }),
    ]
    expect(countDeliveredHours(sessions)).toBe(2)
  })

  it('sums multiple delivered sessions', () => {
    const sessions = [
      s({ id: 'a', state: 'delivered', deliveredHours: 1.5 }),
      s({ id: 'b', state: 'delivered', deliveredHours: 2.5 }),
    ]
    expect(countDeliveredHours(sessions)).toBe(4)
  })

  it('returns zero for an empty list', () => {
    expect(countDeliveredHours([])).toBe(0)
  })
})

describe('isLegalSessionTransition', () => {
  it('disallows undelivering a delivered session (monotonic delivery)', () => {
    expect(isLegalSessionTransition('delivered', 'cancelled')).toBe(false)
    expect(isLegalSessionTransition('delivered', 'no_show')).toBe(false)
    expect(isLegalSessionTransition('delivered', 'tentative')).toBe(false)
  })

  it('allows delivered → delivered (e.g. hours updated)', () => {
    expect(isLegalSessionTransition('delivered', 'delivered')).toBe(true)
  })

  it('allows free movement between non-delivered states', () => {
    expect(isLegalSessionTransition('tentative', 'confirmed')).toBe(true)
    expect(isLegalSessionTransition('confirmed', 'cancelled')).toBe(true)
    expect(isLegalSessionTransition('confirmed', 'delivered')).toBe(true)
  })
})

describe('applyCorrection', () => {
  const original = s({ id: 'orig', state: 'delivered', deliveredHours: 2 })

  it('nets a cancellation correction to zero', () => {
    const replacement = s({
      id: 'repl',
      state: 'delivered',
      deliveredHours: -2,
      correctedSessionId: 'orig',
    })
    expect(applyCorrection({ original, replacement }).netDeliveredHours).toBe(0)
  })

  it('handles a partial correction', () => {
    const replacement = s({
      id: 'repl',
      state: 'delivered',
      deliveredHours: -0.5,
      correctedSessionId: 'orig',
    })
    expect(applyCorrection({ original, replacement }).netDeliveredHours).toBe(1.5)
  })

  it('rejects correcting a non-delivered session', () => {
    const undelivered = s({ id: 'orig2', state: 'confirmed', deliveredHours: 0 })
    const replacement = s({
      id: 'repl',
      state: 'delivered',
      deliveredHours: -1,
      correctedSessionId: 'orig2',
    })
    expect(() => applyCorrection({ original: undelivered, replacement })).toThrow(/not delivered/)
  })

  it('rejects a replacement that does not point at the original', () => {
    const replacement = s({
      id: 'repl',
      state: 'delivered',
      deliveredHours: -2,
      correctedSessionId: 'someone-else',
    })
    expect(() => applyCorrection({ original, replacement })).toThrow(/does not point to original/)
  })
})
