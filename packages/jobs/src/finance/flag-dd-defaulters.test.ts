// Tests for the nightly Direct Debit defaulter flagging. Uses a stubbed
// PrismaClient so we prove idempotent discrepancy upserts and the
// newly-defaulted return set without a DB.

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@studymind/db'

import { defaulterContextHash, flagDefaulters, flagPlanIssues } from './flag-dd-defaulters'

const NOW = new Date('2026-05-26T12:00:00Z')
const D = (iso: string) => new Date(iso)

interface CreatedRow {
  familyId: string
  category: string
  contextHash: string
}

function makeDb(opts: {
  defaulterFamily: {
    familyId: string
    billingName: string
    invoicedMinor: number
    mandateState: string
  }
  existingDiscrepancies?: CreatedRow[]
}): { db: PrismaClient; created: CreatedRow[] } {
  const created: CreatedRow[] = []
  const existing = opts.existingDiscrepancies ?? []
  const f = opts.defaulterFamily

  const mandates = [
    { familyId: f.familyId, state: f.mandateState, id: 'm1', gcMandateId: 'MD1', createdAt: NOW },
  ]
  const payments = [
    {
      familyId: f.familyId,
      provider: 'gocardless',
      amountMinor: 1000,
      reverted: false,
      revertedAt: null,
      receivedAt: D('2026-04-01T10:00:00Z'),
      confirmedAt: D('2026-04-01T10:05:00Z'),
    },
  ]

  const db = {
    family: {
      findUnique: async () => ({
        id: f.familyId,
        billingContact: { firstName: f.billingName, lastName: null },
      }),
    },
    gcMandate: {
      findMany: async (args: { distinct?: string[] }) =>
        args.distinct ? [{ familyId: f.familyId }] : mandates,
    },
    payment: {
      findMany: async (args: { distinct?: string[] }) =>
        args.distinct ? [{ familyId: f.familyId }] : payments,
    },
    invoice: {
      aggregate: async () => ({ _sum: { amountMinor: f.invoicedMinor } }),
    },
    reconciliationDiscrepancy: {
      findFirst: async (args: { where: CreatedRow }) =>
        existing.find(
          (e) =>
            e.familyId === args.where.familyId &&
            e.category === args.where.category &&
            e.contextHash === args.where.contextHash,
        )
          ? { id: 'existing' }
          : null,
      create: async (args: { data: CreatedRow }) => {
        created.push({
          familyId: args.data.familyId,
          category: args.data.category,
          contextHash: args.data.contextHash,
        })
        return { id: 'new' }
      },
    },
  } as unknown as PrismaClient

  return { db, created }
}

describe('flagDefaulters', () => {
  it('raises a direct_debit_default discrepancy for a newly-defaulted family', async () => {
    const { db, created } = makeDb({
      defaulterFamily: {
        familyId: 'fam_1',
        billingName: 'Owes Money',
        invoicedMinor: 10000,
        mandateState: 'failed',
      },
    })
    const result = await flagDefaulters(db, NOW)
    expect(result.scanned).toBe(1)
    expect(result.newlyDefaulted).toHaveLength(1)
    expect(result.newlyDefaulted[0]?.familyId).toBe('fam_1')
    expect(created).toHaveLength(1)
    expect(created[0]?.category).toBe('direct_debit_default')
  })

  it('is idempotent — does not re-create an existing discrepancy', async () => {
    // Precompute the contextHash the row would produce.
    const row = {
      familyId: 'fam_1',
      billingContactName: 'Owes Money',
      mandateStatus: 'failed',
      failedCount: 0,
      lastFailureAt: null,
      totalPaidMinor: 1000,
      totalOwedMinor: 10000,
      outstandingMinor: 9000,
      reasons: ['mandate_inactive_with_balance' as const],
    }
    const hash = defaulterContextHash(row)
    const { db, created } = makeDb({
      defaulterFamily: {
        familyId: 'fam_1',
        billingName: 'Owes Money',
        invoicedMinor: 10000,
        mandateState: 'failed',
      },
      existingDiscrepancies: [
        { familyId: 'fam_1', category: 'direct_debit_default', contextHash: hash },
      ],
    })
    const result = await flagDefaulters(db, NOW)
    expect(result.scanned).toBe(1)
    expect(result.newlyDefaulted).toHaveLength(0)
    expect(created).toHaveLength(0)
  })

  it('does not flag a healthy family (mandate active, fully paid)', async () => {
    const { db, created } = makeDb({
      defaulterFamily: {
        familyId: 'fam_ok',
        billingName: 'All Paid',
        invoicedMinor: 1000,
        mandateState: 'active',
      },
    })
    const result = await flagDefaulters(db, NOW)
    expect(result.newlyDefaulted).toHaveLength(0)
    expect(created).toHaveLength(0)
  })

  it('produces a stable contextHash for the same reasons', () => {
    const base = {
      familyId: 'fam_1',
      billingContactName: null,
      mandateStatus: null,
      failedCount: 0,
      lastFailureAt: null,
      totalPaidMinor: 0,
      totalOwedMinor: 0,
      outstandingMinor: 0,
      reasons: ['a', 'b'] as unknown as never,
    }
    const reordered = { ...base, reasons: ['b', 'a'] as unknown as never }
    expect(defaulterContextHash(base)).toBe(defaulterContextHash(reordered))
  })
})

interface FakeSub {
  gcSubscriptionId: string
  status: string
  amountMinor: number
  currency: string
  intervalUnit: string
  interval: number
  totalPaymentCount: number | null
  startDate: Date | null
  endDate?: Date | null
  nextChargeAt?: Date | null
  gcCustomerId: string | null
}

function makePlanDb(opts: {
  subs: FakeSub[]
  paymentsBySub: Record<string, Array<{ status: string; amountMinor: number; chargeDate: Date }>>
  customers: Array<{ gcCustomerId: string; familyId: string | null; givenName?: string }>
  existing?: CreatedRow[]
}): { db: PrismaClient; created: CreatedRow[] } {
  const created: CreatedRow[] = []
  const existing = opts.existing ?? []

  const db = {
    gcSubscription: {
      findMany: async (args: { where: { status: unknown } }) => {
        const want = args.where.status as { in?: string[] } | string
        return opts.subs.filter((s) =>
          typeof want === 'string' ? s.status === want : (want.in ?? []).includes(s.status),
        )
      },
    },
    gcPayment: {
      findMany: async (args: { where: { gcSubscriptionId: { in: string[] } } }) => {
        const ids = args.where.gcSubscriptionId.in
        return ids.flatMap((id) =>
          (opts.paymentsBySub[id] ?? []).map((p) => ({ ...p, gcSubscriptionId: id })),
        )
      },
    },
    gcCustomer: {
      findMany: async (args: { where: { gcCustomerId: { in: string[] } } }) =>
        opts.customers.filter((c) => args.where.gcCustomerId.in.includes(c.gcCustomerId)),
    },
    reconciliationDiscrepancy: {
      findFirst: async (args: { where: CreatedRow }) =>
        existing.find(
          (e) =>
            e.familyId === args.where.familyId &&
            e.category === args.where.category &&
            e.contextHash === args.where.contextHash,
        )
          ? { id: 'existing' }
          : null,
      create: async (args: { data: CreatedRow }) => {
        created.push({
          familyId: args.data.familyId,
          category: args.data.category,
          contextHash: args.data.contextHash,
        })
        return { id: 'new' }
      },
    },
  } as unknown as PrismaClient

  return { db, created }
}

describe('flagPlanIssues', () => {
  it('raises a plan_shortfall discrepancy for a family-linked cancelled-part-way plan', async () => {
    const { db, created } = makePlanDb({
      subs: [
        {
          gcSubscriptionId: 'SB1',
          status: 'cancelled',
          amountMinor: 10_000,
          currency: 'GBP',
          intervalUnit: 'monthly',
          interval: 1,
          totalPaymentCount: 12,
          startDate: D('2026-01-01T00:00:00Z'),
          gcCustomerId: 'CU1',
        },
      ],
      paymentsBySub: {
        SB1: [
          { status: 'confirmed', amountMinor: 10_000, chargeDate: D('2026-02-01T00:00:00Z') },
          { status: 'confirmed', amountMinor: 10_000, chargeDate: D('2026-03-01T00:00:00Z') },
        ],
      },
      customers: [{ gcCustomerId: 'CU1', familyId: 'fam_1', givenName: 'Pat' }],
    })
    const result = await flagPlanIssues(db, NOW)
    expect(result.newlyFlagged).toHaveLength(1)
    expect(result.newlyFlagged[0]?.kind).toBe('shortfall')
    expect(created).toHaveLength(1)
    expect(created[0]?.category).toBe('direct_debit_plan_shortfall')
  })

  it('skips plans whose customer is not linked to a family', async () => {
    const { db, created } = makePlanDb({
      subs: [
        {
          gcSubscriptionId: 'SB1',
          status: 'cancelled',
          amountMinor: 10_000,
          currency: 'GBP',
          intervalUnit: 'monthly',
          interval: 1,
          totalPaymentCount: 12,
          startDate: D('2026-01-01T00:00:00Z'),
          gcCustomerId: 'CU1',
        },
      ],
      paymentsBySub: { SB1: [] },
      customers: [{ gcCustomerId: 'CU1', familyId: null }],
    })
    const result = await flagPlanIssues(db, NOW)
    expect(result.newlyFlagged).toHaveLength(0)
    expect(created).toHaveLength(0)
  })

  it('raises a plan_arrears discrepancy for an active plan behind schedule', async () => {
    const { db, created } = makePlanDb({
      subs: [
        {
          gcSubscriptionId: 'SB2',
          status: 'active',
          amountMinor: 5_000,
          currency: 'GBP',
          intervalUnit: 'monthly',
          interval: 1,
          totalPaymentCount: null,
          startDate: D('2026-01-01T00:00:00Z'),
          gcCustomerId: 'CU2',
        },
      ],
      // NOW is 2026-05-26 → 5 instalments due; only 1 collected → 4 behind.
      paymentsBySub: {
        SB2: [{ status: 'confirmed', amountMinor: 5_000, chargeDate: D('2026-01-01T00:00:00Z') }],
      },
      customers: [{ gcCustomerId: 'CU2', familyId: 'fam_2' }],
    })
    const result = await flagPlanIssues(db, NOW)
    expect(result.newlyFlagged.some((p) => p.kind === 'arrears')).toBe(true)
    expect(created.some((c) => c.category === 'direct_debit_plan_arrears')).toBe(true)
  })
})
