// Unit tests for the Direct Debit defaulter detection (Slice B). The pure
// classifier is tested directly; listDefaulters / defaulterDetail are tested
// against a stubbed PrismaClient so the candidate selection, paid/owed/
// outstanding maths, and outstanding-desc sorting are proven without a DB.

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'

import {
  classifyDefaulter,
  defaulterDetail,
  listDefaulters,
} from './dd-defaulters'

const NOW = new Date('2026-05-26T12:00:00Z')
const D = (iso: string) => new Date(iso)

function facts(over: Partial<Parameters<typeof classifyDefaulter>[0]> = {}) {
  return {
    familyId: 'fam_1',
    billingContactName: 'Test Family A1',
    invoicedMinor: 0,
    paidMinor: 0,
    revertedPayments: [],
    confirmedGcPayments: [],
    inactiveMandateState: null,
    ...over,
  }
}

describe('classifyDefaulter', () => {
  it('returns null for a healthy family', () => {
    expect(classifyDefaulter(facts({ invoicedMinor: 5000, paidMinor: 5000 }), NOW)).toBeNull()
  })

  it('flags an inactive mandate with an outstanding balance', () => {
    const row = classifyDefaulter(
      facts({ inactiveMandateState: 'failed', invoicedMinor: 10000, paidMinor: 4000 }),
      NOW,
    )
    expect(row).not.toBeNull()
    expect(row?.reasons).toContain('mandate_inactive_with_balance')
    expect(row?.outstandingMinor).toBe(6000)
    expect(row?.mandateStatus).toBe('failed')
  })

  it('does NOT flag an inactive mandate when fully paid up', () => {
    const row = classifyDefaulter(
      facts({ inactiveMandateState: 'cancelled', invoicedMinor: 5000, paidMinor: 5000 }),
      NOW,
    )
    // Cancelled mandate with no balance and no failures is not a defaulter.
    expect(row).toBeNull()
  })

  it('flags a reverted payment that was not re-collected', () => {
    const row = classifyDefaulter(
      facts({
        revertedPayments: [{ amountMinor: 3000, revertedAt: D('2026-05-01T10:00:00Z'), receivedAt: D('2026-04-28T10:00:00Z') }],
        confirmedGcPayments: [], // nothing re-collected
      }),
      NOW,
    )
    expect(row?.reasons).toContain('reverted_payment_not_recollected')
  })

  it('does NOT flag a reverted payment that was fully re-collected', () => {
    const row = classifyDefaulter(
      facts({
        revertedPayments: [{ amountMinor: 3000, revertedAt: D('2026-05-01T10:00:00Z'), receivedAt: D('2026-04-28T10:00:00Z') }],
        confirmedGcPayments: [{ amountMinor: 3000, receivedAt: D('2026-05-10T10:00:00Z') }],
      }),
      NOW,
    )
    expect(row).toBeNull()
  })

  it('flags >= 2 reverted Direct Debits in the trailing 90 days', () => {
    const row = classifyDefaulter(
      facts({
        revertedPayments: [
          { amountMinor: 1000, revertedAt: D('2026-05-01T10:00:00Z'), receivedAt: D('2026-04-28T10:00:00Z') },
          { amountMinor: 1000, revertedAt: D('2026-04-10T10:00:00Z'), receivedAt: D('2026-04-07T10:00:00Z') },
        ],
        // Re-collected so condition 2 does not also fire — isolate condition 3.
        confirmedGcPayments: [{ amountMinor: 2000, receivedAt: D('2026-05-15T10:00:00Z') }],
      }),
      NOW,
    )
    expect(row?.reasons).toEqual(['multiple_failed_direct_debits_90d'])
    expect(row?.failedCount).toBe(2)
    expect(row?.lastFailureAt).toEqual(D('2026-05-01T10:00:00Z'))
  })

  it('ignores failures older than 90 days for condition 3', () => {
    const row = classifyDefaulter(
      facts({
        revertedPayments: [
          { amountMinor: 1000, revertedAt: D('2026-01-01T10:00:00Z'), receivedAt: D('2025-12-28T10:00:00Z') },
          { amountMinor: 1000, revertedAt: D('2026-01-02T10:00:00Z'), receivedAt: D('2025-12-29T10:00:00Z') },
        ],
        confirmedGcPayments: [{ amountMinor: 2000, receivedAt: D('2026-02-01T10:00:00Z') }],
      }),
      NOW,
    )
    expect(row).toBeNull()
  })
})

interface Seed {
  familyId: string
  billingName?: string | null
  invoicedMinor?: number
  mandates?: Array<{ id: string; state: string }>
  payments?: Array<{
    id: string
    provider: string
    amountMinor: number
    reverted?: boolean
    confirmed?: boolean
    revertedAt?: Date | null
    receivedAt?: Date
  }>
}

function makeDb(seeds: Seed[]): PrismaClient {
  const allMandates = seeds.flatMap((s) =>
    (s.mandates ?? []).map((m) => ({ ...m, familyId: s.familyId, gcMandateId: `MD_${m.id}`, createdAt: D('2026-01-01T00:00:00Z') })),
  )
  const allPayments = seeds.flatMap((s) =>
    (s.payments ?? []).map((p) => ({
      ...p,
      familyId: s.familyId,
      currency: 'GBP',
      reverted: p.reverted ?? false,
      confirmedAt: p.confirmed === false ? null : D('2026-04-01T10:00:00Z'),
      revertedAt: p.revertedAt ?? null,
      receivedAt: p.receivedAt ?? D('2026-04-01T10:00:00Z'),
      externalId: `EX_${p.id}`,
      invoice: null,
    })),
  )

  return {
    family: {
      findUnique: async (args: { where: { id: string } }) => {
        const s = seeds.find((x) => x.familyId === args.where.id)
        if (!s) return null
        const [firstName, ...rest] = (s.billingName ?? 'Test Family').split(' ')
        return {
          id: s.familyId,
          billingContact: s.billingName === null ? null : { firstName, lastName: rest.join(' ') || null },
        }
      },
    },
    gcMandate: {
      findMany: async (args: { where: { familyId?: string }; distinct?: string[] }) => {
        if (args.distinct) {
          return Array.from(new Set(allMandates.map((m) => m.familyId))).map((familyId) => ({ familyId }))
        }
        return allMandates.filter((m) => m.familyId === args.where.familyId)
      },
    },
    stripeSubscription: { findMany: async () => [], count: async () => 0 },
    payment: {
      findMany: async (args: {
        where: { familyId?: string; provider?: string }
        distinct?: string[]
        select?: { invoice?: unknown }
      }) => {
        if (args.distinct) {
          return Array.from(
            new Set(allPayments.filter((p) => p.provider === 'gocardless').map((p) => p.familyId)),
          ).map((familyId) => ({ familyId }))
        }
        return allPayments.filter((p) => p.familyId === args.where.familyId)
      },
    },
    invoice: {
      aggregate: async (args: { where: { familyId: string } }) => {
        const s = seeds.find((x) => x.familyId === args.where.familyId)
        return { _sum: { amountMinor: s?.invoicedMinor ?? 0 } }
      },
    },
  } as unknown as PrismaClient
}

describe('listDefaulters', () => {
  it('returns defaulters sorted by outstanding desc, excluding healthy families', async () => {
    const db = makeDb([
      {
        familyId: 'fam_big',
        billingName: 'Big Owed',
        invoicedMinor: 50000,
        mandates: [{ id: 'm1', state: 'failed' }],
        payments: [{ id: 'p1', provider: 'gocardless', amountMinor: 10000 }],
      },
      {
        familyId: 'fam_small',
        billingName: 'Small Owed',
        invoicedMinor: 20000,
        mandates: [{ id: 'm2', state: 'cancelled' }],
        payments: [{ id: 'p2', provider: 'gocardless', amountMinor: 15000 }],
      },
      {
        familyId: 'fam_ok',
        billingName: 'All Paid',
        invoicedMinor: 10000,
        mandates: [{ id: 'm3', state: 'active' }],
        payments: [{ id: 'p3', provider: 'gocardless', amountMinor: 10000 }],
      },
    ])
    const rows = await listDefaulters(db, { now: NOW })
    expect(rows.map((r) => r.familyId)).toEqual(['fam_big', 'fam_small'])
    expect(rows[0]?.outstandingMinor).toBe(40000)
    expect(rows[1]?.outstandingMinor).toBe(5000)
  })

  it('flags a family by reverted-payment signal even with an active mandate', async () => {
    const db = makeDb([
      {
        familyId: 'fam_revert',
        billingName: 'Late Failure',
        invoicedMinor: 3000,
        mandates: [{ id: 'm1', state: 'active' }],
        payments: [
          {
            id: 'p1',
            provider: 'gocardless',
            amountMinor: 3000,
            reverted: true,
            revertedAt: D('2026-05-10T10:00:00Z'),
          },
        ],
      },
    ])
    const rows = await listDefaulters(db, { now: NOW })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reasons).toContain('reverted_payment_not_recollected')
  })
})

describe('defaulterDetail', () => {
  it('returns mandate + payment history with paid/owed/outstanding maths', async () => {
    const db = makeDb([
      {
        familyId: 'fam_1',
        billingName: 'Detail Family',
        invoicedMinor: 12000,
        mandates: [{ id: 'm1', state: 'failed' }],
        payments: [
          { id: 'p1', provider: 'gocardless', amountMinor: 5000 },
          { id: 'p2', provider: 'gocardless', amountMinor: 3000, reverted: true, revertedAt: D('2026-05-01T10:00:00Z') },
        ],
      },
    ])
    const detail = await defaulterDetail(db, 'fam_1')
    expect(detail?.billingContactName).toBe('Detail Family')
    expect(detail?.mandates).toHaveLength(1)
    expect(detail?.payments).toHaveLength(2)
    // Only the confirmed, non-reverted p1 counts as paid.
    expect(detail?.totalPaidMinor).toBe(5000)
    expect(detail?.totalOwedMinor).toBe(12000)
    expect(detail?.outstandingMinor).toBe(7000)
  })

  it('returns null for an unknown family', async () => {
    const db = makeDb([])
    expect(await defaulterDetail(db, 'nope')).toBeNull()
  })
})
