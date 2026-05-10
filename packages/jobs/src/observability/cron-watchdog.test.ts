import { describe, expect, it } from 'vitest'

import { detectCronMisses, type CronStatusReader } from './cron-watchdog'

const NOW = new Date('2026-05-09T12:00:00Z')

function readerOf(map: Record<string, Date | null>): CronStatusReader {
  return {
    lastSuccessAt: (fid) => Promise.resolve(map[fid] ?? null),
  }
}

const HOUR = 60 * 60 * 1000

describe('detectCronMisses', () => {
  it('returns empty when crons are within their interval', async () => {
    const reader = readerOf({
      a: new Date(NOW.getTime() - 30 * 60 * 1000), // 30m ago
    })
    const out = await detectCronMisses(
      reader,
      [{ functionId: 'a', intervalMs: HOUR }],
      NOW,
    )
    expect(out).toEqual([])
  })

  it('flags a single miss as Sev 3', async () => {
    const reader = readerOf({
      a: new Date(NOW.getTime() - 1.6 * HOUR), // 1.6h ago, slack = 1.5h
    })
    const out = await detectCronMisses(
      reader,
      [{ functionId: 'a', intervalMs: HOUR }],
      NOW,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.severity).toBe('sev3')
  })

  it('flags multiple misses as Sev 2', async () => {
    const reader = readerOf({
      a: new Date(NOW.getTime() - 5 * HOUR),
    })
    const out = await detectCronMisses(
      reader,
      [{ functionId: 'a', intervalMs: HOUR }],
      NOW,
    )
    expect(out[0]?.severity).toBe('sev2')
    expect(out[0]?.intervalsMissed).toBe(5)
  })

  it('treats never-run as Sev 2', async () => {
    const reader = readerOf({})
    const out = await detectCronMisses(
      reader,
      [{ functionId: 'never-ran', intervalMs: HOUR }],
      NOW,
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.severity).toBe('sev2')
    expect(out[0]?.lastSuccessAt).toBeNull()
  })
})
