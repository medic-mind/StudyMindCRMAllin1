import { describe, expect, it } from 'vitest'

import { buildQueueCards, type QueueCounts } from './queues'

const ZERO: QueueCounts = {
  missedCalls: 0,
  leadsToTriage: 0,
  openComplaints: 0,
  slackMentions: 0,
  financeDiscrepancies: 0,
  directDebitIssues: 0,
  unresolvedPayments: 0,
}

describe('buildQueueCards', () => {
  it('hides finance queues from non-finance roles', () => {
    const cards = buildQueueCards(ZERO, 'sales_executive')
    const keys = cards.map((c) => c.key)
    expect(keys).not.toContain('financeDiscrepancies')
    expect(keys).not.toContain('directDebitIssues')
    expect(keys).not.toContain('unresolvedPayments')
    // Universal queues are still present.
    expect(keys).toContain('missedCalls')
    expect(keys).toContain('leadsToTriage')
  })

  it('shows finance queues to finance roles', () => {
    for (const role of ['ceo', 'senior_manager', 'manager'] as const) {
      const keys = buildQueueCards(ZERO, role).map((c) => c.key)
      expect(keys).toContain('financeDiscrepancies')
      expect(keys).toContain('directDebitIssues')
      expect(keys).toContain('unresolvedPayments')
    }
  })

  it('hides the whole finance set from a virtual assistant', () => {
    const keys = buildQueueCards(ZERO, 'virtual_assistant').map((c) => c.key)
    expect(keys).toEqual([
      'missedCalls',
      'leadsToTriage',
      'openComplaints',
      'slackMentions',
    ])
  })

  it('sorts non-empty queues by count descending, empty queues last', () => {
    const cards = buildQueueCards(
      { ...ZERO, missedCalls: 2, openComplaints: 9, slackMentions: 5 },
      'sales_executive',
    )
    const ordered = cards.map((c) => c.key)
    expect(ordered.slice(0, 3)).toEqual(['openComplaints', 'slackMentions', 'missedCalls'])
    // Everything after the non-empty queues is a zero-count queue.
    expect(cards.slice(3).every((c) => c.count === 0)).toBe(true)
  })

  it('tones an empty queue calm (success) and a non-empty queue by its active tone', () => {
    const cards = buildQueueCards({ ...ZERO, openComplaints: 3 }, 'manager')
    const complaints = cards.find((c) => c.key === 'openComplaints')
    const missed = cards.find((c) => c.key === 'missedCalls')
    expect(complaints?.tone).toBe('danger')
    expect(missed?.tone).toBe('success')
  })

  it('clamps a negative/garbage count to zero', () => {
    const cards = buildQueueCards({ ...ZERO, missedCalls: -4 }, 'manager')
    const missed = cards.find((c) => c.key === 'missedCalls')
    expect(missed?.count).toBe(0)
    expect(missed?.tone).toBe('success')
  })
})
