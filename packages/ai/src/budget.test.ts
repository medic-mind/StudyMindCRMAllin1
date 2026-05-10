// Budget guardrail tests. See CLAUDE.md Sections 18.3 and 32.

import { beforeEach, describe, expect, it } from 'vitest'

import {
  __resetBudgetForTests,
  BUDGETS,
  checkBudget,
  recordUsage,
} from './budget'

beforeEach(() => {
  __resetBudgetForTests()
})

describe('checkBudget', () => {
  it('returns normal mode at zero spend', () => {
    const result = checkBudget('reply_draft')
    expect(result.allowed).toBe(true)
    expect(result.mode).toBe('normal')
    expect(result.remainingUsd).toBe(BUDGETS.reply_draft.daily)
  })

  it('moves to page mode at 80 percent of daily', () => {
    recordUsage({ task: 'reply_draft', costUsd: BUDGETS.reply_draft.daily * 0.85 })
    const result = checkBudget('reply_draft')
    expect(result.allowed).toBe(true)
    expect(result.mode).toBe('page')
  })

  it('degrades and disallows at 100 percent of daily', () => {
    recordUsage({ task: 'reply_draft', costUsd: BUDGETS.reply_draft.daily })
    const result = checkBudget('reply_draft')
    expect(result.allowed).toBe(false)
    expect(result.mode).toBe('degraded')
    expect(result.remainingUsd).toBe(0)
  })

  it('isolates spend per task category', () => {
    recordUsage({ task: 'reply_draft', costUsd: BUDGETS.reply_draft.daily })
    const other = checkBudget('status_summary')
    expect(other.allowed).toBe(true)
    expect(other.mode).toBe('normal')
  })
})
