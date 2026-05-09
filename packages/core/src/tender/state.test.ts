import { describe, expect, it } from 'vitest'

import {
  isTerminalTenderState,
  TENDER_TRANSITIONS,
  transitionTender,
  type TenderState,
} from './state'

describe('transitionTender', () => {
  it('allows identified → drafting', () => {
    expect(transitionTender('identified', 'drafting')).toEqual({ ok: true, to: 'drafting' })
  })

  it('allows drafting → submitted', () => {
    expect(transitionTender('drafting', 'submitted')).toEqual({ ok: true, to: 'submitted' })
  })

  it('allows submitted → shortlisted → awarded', () => {
    const a = transitionTender('submitted', 'shortlisted')
    expect(a.ok).toBe(true)
    const b = transitionTender('shortlisted', 'awarded')
    expect(b.ok).toBe(true)
  })

  it('allows withdrawn from non-terminal states', () => {
    for (const s of ['identified', 'drafting', 'submitted', 'shortlisted'] as const) {
      expect(transitionTender(s, 'withdrawn').ok).toBe(true)
    }
  })

  it('rejects skipping drafting (identified → submitted)', () => {
    const r = transitionTender('identified', 'submitted')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('illegal_transition')
  })

  it('rejects regression (submitted → drafting)', () => {
    const r = transitionTender('submitted', 'drafting')
    expect(r.ok).toBe(false)
  })

  it('rejects any transition out of a terminal state', () => {
    for (const terminal of ['awarded', 'rejected', 'withdrawn'] as const) {
      for (const target of Object.keys(TENDER_TRANSITIONS) as TenderState[]) {
        if (target === terminal) continue
        expect(transitionTender(terminal, target).ok).toBe(false)
      }
    }
  })

  it('isTerminalTenderState recognises terminals', () => {
    expect(isTerminalTenderState('awarded')).toBe(true)
    expect(isTerminalTenderState('rejected')).toBe(true)
    expect(isTerminalTenderState('withdrawn')).toBe(true)
    expect(isTerminalTenderState('drafting')).toBe(false)
  })
})
