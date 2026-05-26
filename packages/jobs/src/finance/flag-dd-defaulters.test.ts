// Tests for the nightly Direct Debit defaulter flagging. Uses a stubbed
// PrismaClient so we prove idempotent discrepancy upserts and the
// newly-defaulted return set without a DB.

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@studymind/db'

import { defaulterContextHash, flagDefaulters } from './flag-dd-defaulters'

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
