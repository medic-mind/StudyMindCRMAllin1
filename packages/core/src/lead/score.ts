// Lead scoring (ADR 0023). Deterministic 0-100 from signals an agent would
// weigh: contact details supplied, brand/product recognised, multi-service
// interest, high-value intent, parent involvement. Pure + explainable — each
// contribution is returned as a reason so the score is never a black box.

export interface ScoreSignals {
  hasEmail: boolean
  hasPhone: boolean
  hasMessage: boolean
  brandMatched: boolean
  productCount: number
  categoryCount: number
  parentInvolved: boolean
  /** Consultation / interview / application intent present. */
  highValueIntent: boolean
}

export interface ScoreResult {
  score: number
  reasons: string[]
}

export function scoreLead(s: ScoreSignals): ScoreResult {
  let score = 25
  const reasons: string[] = ['base 25']
  if (s.hasEmail) {
    score += 10
    reasons.push('+10 email supplied')
  }
  if (s.hasPhone) {
    score += 15
    reasons.push('+15 phone supplied (higher intent)')
  }
  if (s.hasMessage) {
    score += 10
    reasons.push('+10 wrote a message')
  }
  if (s.brandMatched) {
    score += 10
    reasons.push('+10 brand identified')
  }
  if (s.productCount >= 1) {
    score += 10
    reasons.push('+10 recognised a product')
  }
  if (s.categoryCount >= 2) {
    score += 10
    reasons.push('+10 multiple service interest')
  }
  if (s.highValueIntent) {
    score += 15
    reasons.push('+15 high-value intent')
  }
  if (s.parentInvolved) {
    score += 5
    reasons.push('+5 parent involved')
  }
  score = Math.max(0, Math.min(100, score))
  return { score, reasons }
}
