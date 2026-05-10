// Tests for the SLO violation detector. CLAUDE.md §25.1.

import { describe, expect, it, vi } from 'vitest'

import { detectSloViolations, type AxiomReader } from './slo-monitor'

function readerOf(byApl: Record<string, Array<Record<string, unknown>>>): AxiomReader {
  return {
    query: vi.fn().mockImplementation(async (apl: string) => {
      for (const key of Object.keys(byApl)) {
        if (apl.includes(key)) return { rows: byApl[key] ?? [] }
      }
      return { rows: [] }
    }),
  }
}

const NOW = new Date('2026-05-09T12:00:00Z')
const clock = { now: () => NOW }

describe('detectSloViolations', () => {
  it('returns empty when all SLOs are within budget', async () => {
    const reader = readerOf({
      'web-logs': [{ total: 1000, errors: 0 }],
      'webhook-receive': [{ total: 1000, nonok: 0, provider: 'stripe' }],
      'webhook-to-db': [{ p90: 5000 }],
      'inngest-runs': [{ total: 100, failed: 0 }],
    })
    const out = await detectSloViolations(reader, clock)
    expect(out).toEqual([])
  })

  it('flags web_availability when below 99.9%', async () => {
    const reader = readerOf({
      'web-logs': [{ total: 1000, errors: 5 }], // 99.5% < 99.9%
      'webhook-receive': [],
      'webhook-to-db': [],
      'inngest-runs': [],
    })
    const out = await detectSloViolations(reader, clock)
    expect(out).toHaveLength(1)
    expect(out[0]?.slo).toBe('web_availability')
    expect(out[0]?.value).toBeCloseTo(0.995)
  })

  it('flags webhook_2xx_rate per provider', async () => {
    const reader = readerOf({
      'web-logs': [],
      'webhook-receive': [
        { total: 1000, nonok: 1, provider: 'stripe' }, // 99.9% < 99.95%
        { total: 1000, nonok: 0, provider: 'gocardless' },
      ],
      'webhook-to-db': [],
      'inngest-runs': [],
    })
    const out = await detectSloViolations(reader, clock)
    expect(out).toHaveLength(1)
    expect(out[0]?.slo).toBe('webhook_2xx_rate')
    expect(out[0]?.scope).toBe('stripe')
  })

  it('flags webhook_to_db_latency over 30s p90', async () => {
    const reader = readerOf({
      'web-logs': [],
      'webhook-receive': [],
      'webhook-to-db': [{ p90: 31_000 }],
      'inngest-runs': [],
    })
    const out = await detectSloViolations(reader, clock)
    expect(out).toHaveLength(1)
    expect(out[0]?.slo).toBe('webhook_to_db_latency_p90')
  })

  it('flags inngest success rate below 99.5%', async () => {
    const reader = readerOf({
      'web-logs': [],
      'webhook-receive': [],
      'webhook-to-db': [],
      'inngest-runs': [{ total: 1000, failed: 10 }], // 99% < 99.5%
    })
    const out = await detectSloViolations(reader, clock)
    expect(out).toHaveLength(1)
    expect(out[0]?.slo).toBe('inngest_function_success_rate')
  })

  it('uses a stable period key for de-duplication', async () => {
    const reader = readerOf({
      'web-logs': [{ total: 1000, errors: 5 }],
      'webhook-receive': [],
      'webhook-to-db': [],
      'inngest-runs': [],
    })
    const a = await detectSloViolations(reader, clock)
    const b = await detectSloViolations(reader, clock)
    expect(a[0]?.period).toBe(b[0]?.period)
  })
})
