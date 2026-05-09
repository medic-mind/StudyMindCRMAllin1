import { describe, expect, it } from 'vitest'

import { planDeadlineCandidates, workingDaysUntil } from './deadline-watcher'

describe('workingDaysUntil', () => {
  it('returns 0 for a past or current target', () => {
    const now = new Date('2026-05-09T12:00:00Z')
    expect(workingDaysUntil(new Date('2026-05-09T11:00:00Z'), now)).toBe(0)
  })

  it('approximates 5/7 of calendar days', () => {
    const now = new Date('2026-05-01T00:00:00Z')
    expect(workingDaysUntil(new Date('2026-05-08T00:00:00Z'), now)).toBe(5)
  })
})

describe('planDeadlineCandidates', () => {
  const monthly = (id: string, accountLeadId: string | null = 'lead_1') => ({
    id,
    laName: 'LB Camden',
    reference: id,
    reportingCadence: 'monthly',
    accountLeadId,
  })

  it('returns the contract when within window with no signed report', async () => {
    const now = new Date('2026-05-28T07:00:00Z') // ~3 days to month end
    const out = await planDeadlineCandidates([monthly('c1')], async () => false, now)
    expect(out).toHaveLength(1)
    expect(out[0]?.contractId).toBe('c1')
    expect(out[0]?.period).toBe('2026-05')
  })

  it('skips contracts whose report is already signed for the period', async () => {
    const now = new Date('2026-05-28T07:00:00Z')
    const out = await planDeadlineCandidates([monthly('c1')], async () => true, now)
    expect(out).toHaveLength(0)
  })

  it('skips contracts outside the warn window', async () => {
    const now = new Date('2026-05-01T07:00:00Z')
    const out = await planDeadlineCandidates([monthly('c1')], async () => false, now)
    expect(out).toHaveLength(0)
  })

  it('skips non-monthly cadence', async () => {
    const now = new Date('2026-05-28T07:00:00Z')
    const c = { ...monthly('c1'), reportingCadence: 'termly' }
    const out = await planDeadlineCandidates([c], async () => false, now)
    expect(out).toHaveLength(0)
  })
})
