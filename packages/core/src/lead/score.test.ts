import { describe, expect, it } from 'vitest'

import { scoreLead, type ScoreSignals } from './score'

const empty: ScoreSignals = {
  hasEmail: false,
  hasPhone: false,
  hasMessage: false,
  brandMatched: false,
  productCount: 0,
  categoryCount: 0,
  parentInvolved: false,
  highValueIntent: false,
}

describe('scoreLead', () => {
  it('returns the base score with no signals', () => {
    expect(scoreLead(empty).score).toBe(25)
  })

  it('clamps a maximal lead to 100', () => {
    const { score } = scoreLead({
      hasEmail: true,
      hasPhone: true,
      hasMessage: true,
      brandMatched: true,
      productCount: 3,
      categoryCount: 3,
      parentInvolved: true,
      highValueIntent: true,
    })
    expect(score).toBe(100)
  })

  it('weights a phone above an email (intent signal)', () => {
    const phone = scoreLead({ ...empty, hasPhone: true }).score
    const email = scoreLead({ ...empty, hasEmail: true }).score
    expect(phone).toBeGreaterThan(email)
  })

  it('explains every contribution', () => {
    const { reasons } = scoreLead({ ...empty, hasPhone: true })
    expect(reasons.some((r) => r.includes('phone'))).toBe(true)
  })
})
