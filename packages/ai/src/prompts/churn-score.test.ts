// Tests for the churn-score prompt builder. CLAUDE.md §17.1, §18.

import { describe, expect, it } from 'vitest'

import {
  buildChurnScorePrompt,
  CHURN_TASK_THRESHOLD,
  churnScoreSchema,
  VERSION,
  type ChurnSignals,
} from './churn-score'

const sampleSignals: ChurnSignals = {
  daysSinceLastInteraction: 25,
  paymentFailuresLast60d: 2,
  missedSessionsLast60d: 1,
  sentimentMean: -0.3,
  state: 'active',
  openDiscrepancies: 1,
}

describe('buildChurnScorePrompt', () => {
  it('stamps the version and is deterministic', () => {
    const a = buildChurnScorePrompt({ signals: sampleSignals })
    const b = buildChurnScorePrompt({ signals: sampleSignals })
    expect(a).toEqual(b)
    expect(a.promptVersion).toBe(VERSION)
  })

  it('serialises numeric signals into the user message', () => {
    const out = buildChurnScorePrompt({ signals: sampleSignals })
    expect(out.user).toMatch(/"paymentFailuresLast60d": 2/)
    expect(out.user).toMatch(/"daysSinceLastInteraction": 25/)
  })
})

describe('churnScoreSchema', () => {
  it('accepts a plausible result', () => {
    const parsed = churnScoreSchema.parse({
      score: 0.72,
      drivers: ['Two payment failures', 'No interaction in 25 days', 'Open discrepancy'],
      rationale: 'Recent payment failures and silence indicate attrition risk.',
    })
    expect(parsed.score).toBeGreaterThanOrEqual(CHURN_TASK_THRESHOLD)
  })

  it('rejects fewer than three drivers', () => {
    expect(() =>
      churnScoreSchema.parse({
        score: 0.5,
        drivers: ['only one'],
        rationale: 'short',
      }),
    ).toThrow()
  })

  it('rejects a score above 1', () => {
    expect(() =>
      churnScoreSchema.parse({
        score: 1.4,
        drivers: ['a', 'b', 'c'],
        rationale: 'r',
      }),
    ).toThrow()
  })
})
