// Reconcile-engine unit tests with an in-memory fake of the Prisma client.
// Integration coverage with real Postgres lives in __tests__/integration/.

import { describe, expect, it } from 'vitest'

import { reconcileFamily } from './reconcile'

interface FakeFamily {
  id: string
  state: string
  billingParty?: string
  financialAccount: { status: string } | null
}

interface FakeSession {
  id: string
  bookingId: string
  state: 'tentative' | 'confirmed' | 'delivered' | 'no_show' | 'cancelled'
  deliveredHours: number
  contractedHours: number
  correctedById: string | null
}

interface FakePayment {
  id: string
  familyId: string
  amountMinor: number
  reverted: boolean
  confirmedAt: Date | null
  receivedAt: Date
}

interface FakeAllocation {
  id: string
  paymentId: string
  amountMinor: number
  deletedAt?: Date | null
}

interface FakeSubscription {
  id: string
  familyId: string
  state: string
}

interface FakeBooking {
  id: string
  familyId: string
}

interface FakeMandate {
  id: string
  familyId: string
  state: string
}

interface FakePlacement {
  id: string
  familyId: string
  apReviewDate: Date
  reviewStatus: string
}

interface FakeData {
  families: FakeFamily[]
  bookings: FakeBooking[]
  sessions: FakeSession[]
  payments: FakePayment[]
  allocations: FakeAllocation[]
  subscriptions: FakeSubscription[]
  mandates: FakeMandate[]
  placements: FakePlacement[]
}

function makeFakeDb(seed: Partial<FakeData> = {}) {
  const data: FakeData = {
    families: seed.families ?? [],
    bookings: seed.bookings ?? [],
    sessions: seed.sessions ?? [],
    payments: seed.payments ?? [],
    allocations: seed.allocations ?? [],
    subscriptions: seed.subscriptions ?? [],
    mandates: seed.mandates ?? [],
    placements: seed.placements ?? [],
  }

  return {
    family: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(data.families.find((f) => f.id === where.id) ?? null),
    },
    bookingSession: {
      findMany: ({ where }: { where: { booking: { familyId: string } } }) => {
        const bookingIds = data.bookings
          .filter((b) => b.familyId === where.booking.familyId)
          .map((b) => b.id)
        return Promise.resolve(data.sessions.filter((s) => bookingIds.includes(s.bookingId)))
      },
    },
    payment: {
      findMany: ({ where }: { where: { familyId: string } }) =>
        Promise.resolve(data.payments.filter((p) => p.familyId === where.familyId)),
    },
    allocation: {
      findMany: ({
        where,
      }: {
        where: { payment: { familyId: string }; deletedAt?: Date | null }
      }) => {
        const ids = data.payments
          .filter((p) => p.familyId === where.payment.familyId)
          .map((p) => p.id)
        return Promise.resolve(
          data.allocations.filter(
            (a) =>
              ids.includes(a.paymentId) &&
              // Honour the `deletedAt: null` filter like the real DB — a
              // soft-deleted (superseded) allocation must not be summed.
              !(where.deletedAt === null && (a.deletedAt ?? null) !== null),
          ),
        )
      },
    },
    stripeSubscription: {
      findMany: ({
        where,
      }: {
        where: { familyId: string; state: string | { in: string[] } }
      }) => {
        const states =
          typeof where.state === 'string' ? [where.state] : where.state.in
        return Promise.resolve(
          data.subscriptions.filter(
            (s) => s.familyId === where.familyId && states.includes(s.state),
          ),
        )
      },
    },
    gcMandate: {
      findMany: ({
        where,
      }: {
        where: { familyId: string; state: { in: string[] } }
      }) =>
        Promise.resolve(
          data.mandates.filter(
            (m) => m.familyId === where.familyId && where.state.in.includes(m.state),
          ),
        ),
    },
    aPPlacement: {
      findUnique: ({ where }: { where: { familyId: string } }) =>
        Promise.resolve(data.placements.find((p) => p.familyId === where.familyId) ?? null),
    },
  } as never
}

describe('reconcileFamily', () => {
  it('returns nothing for an empty active family', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toEqual([])
  })

  it('surfaces an unallocated confirmed payment', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      payments: [
        {
          id: 'p1',
          familyId: 'f1',
          amountMinor: 10_000,
          reverted: false,
          confirmedAt: new Date('2026-05-01'),
          receivedAt: new Date('2026-05-01'),
        },
      ],
      allocations: [{ id: 'a1', paymentId: 'p1', amountMinor: 4_000 }],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      category: 'payment_unallocated',
      payload: { unallocatedMinor: 6_000, allocatedMinor: 4_000 },
    })
  })

  it('does not surface unallocated payment when the payment is reverted', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      payments: [
        {
          id: 'p1',
          familyId: 'f1',
          amountMinor: 10_000,
          reverted: true,
          confirmedAt: new Date('2026-05-01'),
          receivedAt: new Date('2026-05-01'),
        },
      ],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toEqual([])
  })

  it('throws when allocations exceed the payment (§41.2)', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      payments: [
        {
          id: 'p1',
          familyId: 'f1',
          amountMinor: 5_000,
          reverted: false,
          confirmedAt: new Date('2026-05-01'),
          receivedAt: new Date('2026-05-01'),
        },
      ],
      allocations: [
        { id: 'a1', paymentId: 'p1', amountMinor: 3_000 },
        { id: 'a2', paymentId: 'p1', amountMinor: 4_000 },
      ],
    })
    await expect(reconcileFamily(db, 'f1')).rejects.toThrow(/Allocation invariant/)
  })

  it('ignores soft-deleted (superseded) allocations — no false invariant throw', async () => {
    // Regression: re-allocating soft-deletes the old row and creates a new one.
    // Summing both would exceed the payment and wrongly trip the §41.2 invariant
    // (wedging the nightly pipeline). Only the active allocation must count.
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      payments: [
        {
          id: 'p1',
          familyId: 'f1',
          amountMinor: 5_000,
          reverted: false,
          confirmedAt: new Date('2026-05-01'),
          receivedAt: new Date('2026-05-01'),
        },
      ],
      allocations: [
        { id: 'a1', paymentId: 'p1', amountMinor: 5_000, deletedAt: new Date('2026-05-02') },
        { id: 'a2', paymentId: 'p1', amountMinor: 5_000, deletedAt: null },
      ],
    })
    const result = await reconcileFamily(db, 'f1')
    // Fully allocated by the active row → no invariant throw, no unallocated row.
    expect(
      result.discrepancies.find((d) => d.category === 'payment_unallocated'),
    ).toBeUndefined()
  })

  it('surfaces churned + active subscription', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'churned', financialAccount: { status: 'ok' } }],
      subscriptions: [{ id: 'sub_1', familyId: 'f1', state: 'active' }],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]).toMatchObject({
      category: 'churned_with_active_subscription',
      payload: { subscriptionIds: ['sub_1'] },
    })
  })

  it('surfaces late-failure pending action from FinancialAccount status', async () => {
    const db = makeFakeDb({
      families: [
        {
          id: 'f1',
          state: 'active',
          financialAccount: { status: 'reverted_payment_pending_action' },
        },
      ],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]?.category).toBe('late_failure_pending_action')
  })

  it('surfaces hours_mismatch when delivered exceeds contracted', async () => {
    const db = makeFakeDb({
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      bookings: [{ id: 'b1', familyId: 'f1' }],
      sessions: [
        {
          id: 's1',
          bookingId: 'b1',
          state: 'delivered',
          deliveredHours: 5,
          contractedHours: 2,
          correctedById: null,
        },
      ],
    })
    const result = await reconcileFamily(db, 'f1')
    expect(result.discrepancies).toHaveLength(1)
    expect(result.discrepancies[0]?.category).toBe('hours_mismatch')
  })

  it('produces stable contextHash for identical inputs', async () => {
    const seed = {
      families: [{ id: 'f1', state: 'active', financialAccount: { status: 'ok' } }],
      payments: [
        {
          id: 'p1',
          familyId: 'f1',
          amountMinor: 10_000,
          reverted: false,
          confirmedAt: new Date('2026-05-01'),
          receivedAt: new Date('2026-05-01'),
        },
      ],
      allocations: [{ id: 'a1', paymentId: 'p1', amountMinor: 4_000 }],
    }
    const a = await reconcileFamily(makeFakeDb(seed), 'f1')
    const b = await reconcileFamily(makeFakeDb(seed), 'f1')
    expect(a.discrepancies[0]?.contextHash).toBe(b.discrepancies[0]?.contextHash)
  })
})
