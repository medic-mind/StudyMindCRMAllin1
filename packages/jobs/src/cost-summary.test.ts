// Tests for the weekly cost-summary aggregator. Pure functions; no I/O.
// CLAUDE.md §32.

import { describe, expect, it } from 'vitest'

import {
  aggregateCostSummary,
  collectCostInputs,
  costSummaryS3Key,
  renderCostMarkdown,
} from './cost-summary'

describe('aggregateCostSummary', () => {
  const now = new Date('2026-05-04T09:00:00Z') // Monday

  it('multiplies the drift sample by 100 by default', () => {
    const r = aggregateCostSummary({
      samples: [
        { task: 'reply_draft', costUsd: 0.01, sampledAt: new Date('2026-05-02T10:00:00Z') },
        { task: 'reply_draft', costUsd: 0.02, sampledAt: new Date('2026-05-03T10:00:00Z') },
        { task: 'churn_score', costUsd: 0.001, sampledAt: new Date('2026-05-03T10:00:00Z') },
      ],
      storage: { aircallRecordings: 5, emailAttachments: 7 },
      now,
    })
    expect(r.aiByTaskUsd['reply_draft']).toBeCloseTo(3.0, 5)
    expect(r.aiByTaskUsd['churn_score']).toBeCloseTo(0.1, 5)
    expect(r.aiTotalUsd).toBeCloseTo(3.1, 5)
    expect(r.weekIso).toMatch(/^2026-W/)
    expect(r.storage.aircallRecordings).toBe(5)
  })

  it('drops samples outside the 7-day window', () => {
    const r = aggregateCostSummary({
      samples: [
        // Too old:
        { task: 't', costUsd: 0.5, sampledAt: new Date('2025-01-01T10:00:00Z') },
        // In-window:
        { task: 't', costUsd: 0.01, sampledAt: new Date('2026-05-02T10:00:00Z') },
      ],
      storage: { aircallRecordings: 0, emailAttachments: 0 },
      now,
    })
    expect(r.aiTotalUsd).toBeCloseTo(1.0, 5)
  })

  it('renders a deterministic markdown report', () => {
    const r = aggregateCostSummary({
      samples: [
        { task: 'reply_draft', costUsd: 0.01, sampledAt: new Date('2026-05-02T10:00:00Z') },
      ],
      storage: { aircallRecordings: 1, emailAttachments: 2 },
      now,
    })
    const md = renderCostMarkdown(r)
    expect(md).toContain('# StudyMind CRM cost summary')
    expect(md).toContain('reply_draft')
    expect(md).toContain('Aircall recordings retained: 1')
    expect(md).toContain('Email attachments retained: 2')
  })

  it('s3 key path is week-stable', () => {
    expect(costSummaryS3Key('2026-W18')).toBe('cost-reports/2026-W18.md')
  })
})

describe('collectCostInputs', () => {
  it('reads DriftSample rows + interaction proxy counts', async () => {
    const samples = [
      { task: 'reply_draft', costUsd: 0.01, sampledAt: new Date('2026-05-02T10:00:00Z') },
    ]
    const db = {
      driftSample: { findMany: () => Promise.resolve(samples) },
      interaction: {
        count: ({ where }: { where: { type: string } }) =>
          Promise.resolve(where.type === 'call' ? 3 : 4),
      },
    }
    const r = await collectCostInputs(db as never, new Date('2026-05-04T00:00:00Z'))
    expect(r.samples).toHaveLength(1)
    expect(r.storage.aircallRecordings).toBe(3)
    expect(r.storage.emailAttachments).toBe(4)
  })
})
