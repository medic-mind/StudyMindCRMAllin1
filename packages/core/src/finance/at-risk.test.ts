// Unit tests for at-risk derivation. CLAUDE.md §6.4.

import { describe, expect, it, vi, beforeEach } from 'vitest'

import { deriveAtRisk, recomputeAtRiskForFamily, type AtRiskSignals } from './at-risk'

const now = new Date('2026-05-10T00:00:00Z')

function emptySignals(): AtRiskSignals {
  return {
    stripeSubscription: null,
    recentFailedDirectDebits: [],
    latestChurnScore: null,
    now,
  }
}

describe('deriveAtRisk', () => {
  const family = { id: 'fam_1', state: 'active' as const }

  it('returns false when no signals fire', () => {
    expect(deriveAtRisk(family, emptySignals())).toEqual({ atRisk: false, reasons: [] })
  })

  it('flags Stripe past_due when older than 3 days', () => {
    const signals = emptySignals()
    signals.stripeSubscription = {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000),
    }
    const r = deriveAtRisk(family, signals)
    expect(r.atRisk).toBe(true)
    expect(r.reasons[0]).toMatch(/stripe_subscription_past_due_4_days/)
  })

  it('does NOT flag Stripe past_due when within 3 days', () => {
    const signals = emptySignals()
    signals.stripeSubscription = {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
    }
    expect(deriveAtRisk(family, signals).atRisk).toBe(false)
  })

  it('flags two failed Direct Debits in the last 60 days', () => {
    const signals = emptySignals()
    signals.recentFailedDirectDebits = [
      { receivedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) },
      { receivedAt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000) },
    ]
    const r = deriveAtRisk(family, signals)
    expect(r.atRisk).toBe(true)
    expect(r.reasons[0]).toMatch(/gocardless_failed_direct_debits_2/)
  })

  it('does NOT flag a single failed DD', () => {
    const signals = emptySignals()
    signals.recentFailedDirectDebits = [
      { receivedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) },
    ]
    expect(deriveAtRisk(family, signals).atRisk).toBe(false)
  })

  it('ignores failed DDs older than 60 days', () => {
    const signals = emptySignals()
    signals.recentFailedDirectDebits = [
      { receivedAt: new Date(now.getTime() - 70 * 24 * 60 * 60 * 1000) },
      { receivedAt: new Date(now.getTime() - 80 * 24 * 60 * 60 * 1000) },
    ]
    expect(deriveAtRisk(family, signals).atRisk).toBe(false)
  })

  it('flags churn score >= 0.7', () => {
    const signals = emptySignals()
    signals.latestChurnScore = 0.72
    const r = deriveAtRisk(family, signals)
    expect(r.atRisk).toBe(true)
    expect(r.reasons[0]).toMatch(/churn_score_0\.72/)
  })

  it('does NOT flag churn score below threshold', () => {
    const signals = emptySignals()
    signals.latestChurnScore = 0.5
    expect(deriveAtRisk(family, signals).atRisk).toBe(false)
  })

  it('combines multiple reasons', () => {
    const signals = emptySignals()
    signals.stripeSubscription = {
      state: 'past_due',
      pastDueSince: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
    }
    signals.recentFailedDirectDebits = [
      { receivedAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000) },
      { receivedAt: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000) },
    ]
    signals.latestChurnScore = 0.9
    const r = deriveAtRisk(family, signals)
    expect(r.atRisk).toBe(true)
    expect(r.reasons).toHaveLength(3)
  })
})

describe('recomputeAtRiskForFamily', () => {
  // Hand-rolled mock with the few model methods we touch. `any` is fine in
  // tests; production code goes through the real PrismaClient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any

  beforeEach(() => {
    db = {
      family: {
        findUnique: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
      },
      stripeSubscription: { findFirst: vi.fn().mockResolvedValue(null) },
      payment: { findMany: vi.fn().mockResolvedValue([]) },
      churnScore: { findFirst: vi.fn().mockResolvedValue(null) },
      interaction: { create: vi.fn().mockResolvedValue({}) },
      auditLogEntry: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    }
  })

  it('does nothing if family is missing', async () => {
    db.family.findUnique.mockResolvedValue(null)
    const r = await recomputeAtRiskForFamily(db, 'fam_missing')
    expect(r.changed).toBe(false)
    expect(db.family.update).not.toHaveBeenCalled()
  })

  it('does nothing when active family has no risk signals', async () => {
    db.family.findUnique.mockResolvedValue({ id: 'fam_1', state: 'active' })
    const r = await recomputeAtRiskForFamily(db, 'fam_1')
    expect(r.changed).toBe(false)
    expect(db.family.update).not.toHaveBeenCalled()
    expect(db.interaction.create).not.toHaveBeenCalled()
  })

  it('does nothing when at_risk family still has risk signals', async () => {
    db.family.findUnique.mockResolvedValue({ id: 'fam_1', state: 'at_risk' })
    db.churnScore.findFirst.mockResolvedValue({ score: 0.9 })
    const r = await recomputeAtRiskForFamily(db, 'fam_1')
    expect(r.changed).toBe(false)
    expect(db.family.update).not.toHaveBeenCalled()
  })

  it('transitions active -> at_risk when signals fire', async () => {
    db.family.findUnique.mockResolvedValue({ id: 'fam_1', state: 'active' })
    db.churnScore.findFirst.mockResolvedValue({ score: 0.85 })
    const r = await recomputeAtRiskForFamily(db, 'fam_1')
    expect(r.changed).toBe(true)
    expect(r.to).toBe('at_risk')
    expect(db.family.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'fam_1' }, data: { state: 'at_risk' } }),
    )
    expect(db.interaction.create).toHaveBeenCalled()
    expect(db.auditLogEntry.create).toHaveBeenCalled()
  })

  it('transitions at_risk -> active when signals clear', async () => {
    db.family.findUnique.mockResolvedValue({ id: 'fam_1', state: 'at_risk' })
    const r = await recomputeAtRiskForFamily(db, 'fam_1')
    expect(r.changed).toBe(true)
    expect(r.to).toBe('active')
    expect(db.family.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { state: 'active' } }),
    )
  })

  it('does NOT auto-transition lead/trial/churned families', async () => {
    db.family.findUnique.mockResolvedValue({ id: 'fam_1', state: 'lead' })
    db.churnScore.findFirst.mockResolvedValue({ score: 0.95 })
    const r = await recomputeAtRiskForFamily(db, 'fam_1')
    expect(r.changed).toBe(false)
    expect(db.family.update).not.toHaveBeenCalled()
  })
})
