// Unit tests for the per-customer payments view-models. Uses a stubbed
// PrismaClient that returns the rows we pass in — the shapers are pure data
// transforms over the canonical Payment / Invoice / mandate / subscription
// mirrors, so this proves status derivation, refund netting, mandate /
// subscription linkage, and the summary maths without booting a real DB.

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'

import { paymentsForFamily, paymentSummaryForFamily } from './customer-payments'

interface PaymentSeed {
  id: string
  provider: string
  amountMinor: number
  currency?: string
  receivedAt: Date
  confirmedAt?: Date | null
  reverted?: boolean
  revertedAt?: Date | null
  externalId: string
  invoice?: { id: string; externalId: string } | null
  refundIntents?: Array<{ amountMinor: number; status: string }>
}

interface MandateSeed {
  id: string
  gcMandateId: string
  state: string
}
interface SubscriptionSeed {
  id: string
  stripeId: string
  state: string
}

function makeDb(opts: {
  payments?: PaymentSeed[]
  mandates?: MandateSeed[]
  subscriptions?: SubscriptionSeed[]
  invoicesTotalMinor?: number
}): PrismaClient {
  const payments = opts.payments ?? []
  const mandates = opts.mandates ?? []
  const subscriptions = opts.subscriptions ?? []
  return {
    payment: {
      // Mirror Prisma's `orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }]`.
      findMany: async () =>
        payments
          .slice()
          .sort(
            (a, b) =>
              b.receivedAt.getTime() - a.receivedAt.getTime() ||
              (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
          )
          .map((p) => ({
          id: p.id,
          provider: p.provider,
          amountMinor: p.amountMinor,
          currency: p.currency ?? 'GBP',
          receivedAt: p.receivedAt,
          confirmedAt: p.confirmedAt ?? null,
          reverted: p.reverted ?? false,
          revertedAt: p.revertedAt ?? null,
          externalId: p.externalId,
          invoice: p.invoice ?? null,
          refundIntents: p.refundIntents ?? [],
        })),
    },
    gcMandate: {
      findMany: async () => mandates,
      count: async (args: { where: { state?: string } }) =>
        mandates.filter((m) => !args.where.state || m.state === args.where.state).length,
    },
    stripeSubscription: {
      findMany: async () => subscriptions,
      count: async (args: { where: { state?: string } }) =>
        subscriptions.filter((s) => !args.where.state || s.state === args.where.state)
          .length,
    },
    invoice: {
      aggregate: async () => ({ _sum: { amountMinor: opts.invoicesTotalMinor ?? 0 } }),
    },
  } as unknown as PrismaClient
}

const D = (iso: string) => new Date(iso)

describe('paymentsForFamily', () => {
  it('returns rows sorted newest first with derived status', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p_old',
          provider: 'stripe',
          amountMinor: 5000,
          receivedAt: D('2026-01-01T10:00:00Z'),
          confirmedAt: D('2026-01-01T10:05:00Z'),
          externalId: 'ch_old',
        },
        {
          id: 'p_new',
          provider: 'gocardless',
          amountMinor: 3000,
          receivedAt: D('2026-02-01T10:00:00Z'),
          confirmedAt: D('2026-02-01T10:05:00Z'),
          externalId: 'PM_new',
        },
      ],
    })
    const rows = await paymentsForFamily(db, 'fam_1')
    expect(rows.map((r) => r.id)).toEqual(['p_new', 'p_old'])
    expect(rows.every((r) => r.status === 'paid')).toBe(true)
  })

  it('derives failed status for reverted (late-failure) payments', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p_reverted',
          provider: 'gocardless',
          amountMinor: 4200,
          receivedAt: D('2026-03-01T10:00:00Z'),
          confirmedAt: D('2026-03-01T10:05:00Z'),
          reverted: true,
          revertedAt: D('2026-03-03T10:00:00Z'),
          externalId: 'PM_rev',
        },
      ],
    })
    const [row] = await paymentsForFamily(db, 'fam_1')
    expect(row?.status).toBe('failed')
    expect(row?.reverted).toBe(true)
  })

  it('derives pending status when not yet confirmed', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p_pending',
          provider: 'gocardless',
          amountMinor: 1000,
          receivedAt: D('2026-03-10T10:00:00Z'),
          confirmedAt: null,
          externalId: 'PM_pend',
        },
      ],
    })
    const [row] = await paymentsForFamily(db, 'fam_1')
    expect(row?.status).toBe('pending')
  })

  it('nets succeeded refunds and flags full refunds as refunded', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p_partial',
          provider: 'stripe',
          amountMinor: 10000,
          receivedAt: D('2026-03-01T10:00:00Z'),
          confirmedAt: D('2026-03-01T10:05:00Z'),
          externalId: 'ch_partial',
          refundIntents: [
            { amountMinor: 2000, status: 'succeeded' },
            { amountMinor: 9999, status: 'pending' }, // ignored — not succeeded
          ],
        },
        {
          id: 'p_full',
          provider: 'stripe',
          amountMinor: 5000,
          receivedAt: D('2026-03-02T10:00:00Z'),
          confirmedAt: D('2026-03-02T10:05:00Z'),
          externalId: 'ch_full',
          refundIntents: [{ amountMinor: 5000, status: 'succeeded' }],
        },
      ],
    })
    const rows = await paymentsForFamily(db, 'fam_1')
    const partial = rows.find((r) => r.id === 'p_partial')
    const full = rows.find((r) => r.id === 'p_full')
    expect(partial?.refundedMinor).toBe(2000)
    expect(partial?.status).toBe('paid')
    expect(full?.refundedMinor).toBe(5000)
    expect(full?.status).toBe('refunded')
  })

  it('links GoCardless payments to the active mandate and Stripe to the active subscription', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p_gc',
          provider: 'gocardless',
          amountMinor: 1000,
          receivedAt: D('2026-03-01T10:00:00Z'),
          confirmedAt: D('2026-03-01T10:05:00Z'),
          externalId: 'PM_gc',
        },
        {
          id: 'p_st',
          provider: 'stripe',
          amountMinor: 2000,
          receivedAt: D('2026-03-02T10:00:00Z'),
          confirmedAt: D('2026-03-02T10:05:00Z'),
          externalId: 'ch_st',
        },
      ],
      mandates: [
        { id: 'm_old', gcMandateId: 'MD_old', state: 'cancelled' },
        { id: 'm_active', gcMandateId: 'MD_active', state: 'active' },
      ],
      subscriptions: [{ id: 's_active', stripeId: 'sub_active', state: 'active' }],
    })
    const rows = await paymentsForFamily(db, 'fam_1')
    const gc = rows.find((r) => r.id === 'p_gc')
    const st = rows.find((r) => r.id === 'p_st')
    expect(gc?.relatedMandate?.id).toBe('m_active')
    expect(gc?.relatedSubscription).toBeNull()
    expect(st?.relatedSubscription?.id).toBe('s_active')
    expect(st?.relatedMandate).toBeNull()
  })
})

describe('paymentSummaryForFamily', () => {
  it('aggregates paid / refunded / failed and computes open invoice', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p1',
          provider: 'stripe',
          amountMinor: 10000,
          receivedAt: D('2026-01-01T10:00:00Z'),
          confirmedAt: D('2026-01-01T10:05:00Z'),
          externalId: 'ch1',
          refundIntents: [{ amountMinor: 2000, status: 'succeeded' }],
        },
        {
          id: 'p2',
          provider: 'gocardless',
          amountMinor: 5000,
          receivedAt: D('2026-02-01T10:00:00Z'),
          confirmedAt: D('2026-02-01T10:05:00Z'),
          reverted: true,
          revertedAt: D('2026-02-03T10:00:00Z'),
          externalId: 'PM2',
        },
        {
          id: 'p3',
          provider: 'gocardless',
          amountMinor: 3000,
          receivedAt: D('2026-03-01T10:00:00Z'),
          confirmedAt: null,
          externalId: 'PM3',
        },
      ],
      mandates: [{ id: 'm1', gcMandateId: 'MD1', state: 'active' }],
      subscriptions: [
        { id: 's1', stripeId: 'sub1', state: 'active' },
        { id: 's2', stripeId: 'sub2', state: 'canceled' },
      ],
      invoicesTotalMinor: 20000,
    })
    const s = await paymentSummaryForFamily(db, 'fam_1')
    // p1: paid 10000 - 2000 refund = 8000 net paid; refunded 2000.
    // p2: failed 5000. p3: pending — not counted in paid/failed.
    expect(s.totalPaidMinor).toBe(8000)
    expect(s.totalRefundedMinor).toBe(2000)
    expect(s.totalFailedMinor).toBe(5000)
    // open invoice = 20000 invoiced - 8000 net paid = 12000.
    expect(s.openInvoiceMinor).toBe(12000)
    expect(s.activeMandates).toBe(1)
    expect(s.activeSubscriptions).toBe(1)
    expect(s.lastPaymentAt).toEqual(D('2026-01-01T10:00:00Z'))
  })

  it('clamps open invoice at zero when payments exceed invoices', async () => {
    const db = makeDb({
      payments: [
        {
          id: 'p1',
          provider: 'stripe',
          amountMinor: 10000,
          receivedAt: D('2026-01-01T10:00:00Z'),
          confirmedAt: D('2026-01-01T10:05:00Z'),
          externalId: 'ch1',
        },
      ],
      invoicesTotalMinor: 4000,
    })
    const s = await paymentSummaryForFamily(db, 'fam_1')
    expect(s.openInvoiceMinor).toBe(0)
  })

  it('returns zeroed summary with null lastPaymentAt for a family with no payments', async () => {
    const db = makeDb({})
    const s = await paymentSummaryForFamily(db, 'fam_1')
    expect(s).toEqual({
      totalPaidMinor: 0,
      totalRefundedMinor: 0,
      totalFailedMinor: 0,
      openInvoiceMinor: 0,
      activeMandates: 0,
      activeSubscriptions: 0,
      lastPaymentAt: null,
    })
  })
})
