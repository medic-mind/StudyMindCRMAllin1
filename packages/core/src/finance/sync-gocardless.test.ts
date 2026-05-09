// Unit tests for sync-gocardless. The Prisma client is faked in-memory so
// the reversal flow can be exercised end-to-end without Postgres. Integration
// coverage for the same path lives in __tests__/integration/.
//
// CLAUDE.md §9: late_failure_settled reverses a previously-confirmed
// payment, deletes its allocations, and flips the FinancialAccount flag to
// `reverted_payment_pending_action` so finance can act before dunning.

import { describe, expect, it } from 'vitest'

import { revertGcPayment, syncGcMandate, syncGcPayment } from './sync-gocardless'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb() {
  const families: FakeRow[] = [{ id: 'fam_1' }]
  const mandates: FakeRow[] = []
  const payments: FakeRow[] = []
  const allocations: FakeRow[] = []
  const financialAccounts: FakeRow[] = []

  let idSeq = 0
  const nextId = (prefix: string): string => {
    idSeq += 1
    return `${prefix}_${idSeq}`
  }

  const db = {
    gcMandate: {
      findUnique: ({ where }: { where: { gcMandateId: string } }) =>
        Promise.resolve(mandates.find((m) => m['gcMandateId'] === where.gcMandateId) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data } as FakeRow
        mandates.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = mandates.find((m) => m.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { gcMandateId: string }
        data: Record<string, unknown>
      }) => {
        const rows = mandates.filter((m) => m['gcMandateId'] === where.gcMandateId)
        rows.forEach((r) => Object.assign(r, data))
        return Promise.resolve({ count: rows.length })
      },
    },
    payment: {
      findUnique: ({ where }: { where: { externalId: string } }) =>
        Promise.resolve(payments.find((p) => p['externalId'] === where.externalId) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data } as FakeRow
        payments.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = payments.find((p) => p.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
    allocation: {
      deleteMany: ({ where }: { where: { paymentId: string } }) => {
        const before = allocations.length
        for (let i = allocations.length - 1; i >= 0; i--) {
          if (allocations[i]!['paymentId'] === where.paymentId) {
            allocations.splice(i, 1)
          }
        }
        return Promise.resolve({ count: before - allocations.length })
      },
    },
    financialAccount: {
      findUnique: ({ where }: { where: { familyId: string } }) =>
        Promise.resolve(
          financialAccounts.find((fa) => fa['familyId'] === where.familyId) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data } as FakeRow
        financialAccounts.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = financialAccounts.find((fa) => fa.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
  }

  return { db, mandates, payments, allocations, financialAccounts, nextId, families }
}

describe('GoCardless late-failure reversal', () => {
  it('confirms a payment, then reverses it on late_failure_settled', async () => {
    const { db, payments, allocations, financialAccounts } = makeFakeDb()

    // Seed: an active mandate links the payment to a Family.
    await syncGcMandate(db as never, {
      gcMandateId: 'MD_1',
      state: 'active',
      familyId: 'fam_1',
    })

    // Confirm a payment.
    const confirmed = await syncGcPayment(db as never, {
      gcPaymentId: 'PM_1',
      gcMandateId: 'MD_1',
      amountMinor: 19500,
      currency: 'GBP',
      receivedAt: new Date('2026-04-30T08:00:00Z'),
      confirmedAt: new Date('2026-04-30T08:00:00Z'),
    })
    expect(confirmed.unresolved).toBe(false)
    expect(payments).toHaveLength(1)
    // Schema default `reverted: false` is applied by Prisma in production;
    // the in-memory fake doesn't re-apply column defaults, so we treat
    // either undefined or false as the pre-reversal state.
    expect(payments[0]!['reverted']).toBeFalsy()

    // Pretend an allocation was attached during reconciliation.
    allocations.push({ id: 'al_1', paymentId: payments[0]!.id, bookingId: 'bk_1', amountMinor: 19500 })

    // Late-failure settles two days later.
    const result = await revertGcPayment(db as never, {
      gcPaymentId: 'PM_1',
      occurredAt: new Date('2026-05-02T09:00:00Z'),
    })

    expect(result.paymentId).toBe(payments[0]!.id)
    expect(result.familyId).toBe('fam_1')
    expect(result.reopenedAllocations).toBe(1)
    expect(payments[0]!['reverted']).toBe(true)
    expect(payments[0]!['revertedAt']).toEqual(new Date('2026-05-02T09:00:00Z'))
    expect(allocations).toHaveLength(0)
    expect(financialAccounts).toHaveLength(1)
    expect(financialAccounts[0]!['status']).toBe('reverted_payment_pending_action')
  })

  it('is idempotent on replay — second call short-circuits', async () => {
    const { db } = makeFakeDb()
    await syncGcMandate(db as never, {
      gcMandateId: 'MD_2',
      state: 'active',
      familyId: 'fam_1',
    })
    await syncGcPayment(db as never, {
      gcPaymentId: 'PM_2',
      gcMandateId: 'MD_2',
      amountMinor: 1000,
      currency: 'GBP',
      receivedAt: new Date(),
      confirmedAt: new Date(),
    })

    const first = await revertGcPayment(db as never, {
      gcPaymentId: 'PM_2',
      occurredAt: new Date(),
    })
    expect(first.reopenedAllocations).toBe(0)

    const second = await revertGcPayment(db as never, {
      gcPaymentId: 'PM_2',
      occurredAt: new Date(),
    })
    // Already reverted: no further allocations to re-open.
    expect(second.paymentId).toBe(first.paymentId)
    expect(second.reopenedAllocations).toBe(0)
  })

  it('returns null when the payment is unknown — never silently creates one', async () => {
    const { db } = makeFakeDb()
    const result = await revertGcPayment(db as never, {
      gcPaymentId: 'PM_does_not_exist',
      occurredAt: new Date(),
    })
    expect(result.paymentId).toBeNull()
    expect(result.familyId).toBeNull()
    expect(result.reopenedAllocations).toBe(0)
  })
})
