// Unit tests for the Stripe payment mirror helpers. The Prisma client is faked
// in-memory (same style as sync-gocardless.test.ts) so idempotency and the
// unresolved-customer path can be exercised without Postgres.

import { describe, expect, it } from 'vitest'

import { revertStripePayment, syncStripePayment } from './sync-stripe'

interface Row {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: { linkedCustomer?: string | null } = {}) {
  const stripeCustomers: Row[] = opts.linkedCustomer
    ? [{ id: 'sc_1', stripeCustomerId: opts.linkedCustomer, familyId: 'fam_1' }]
    : []
  const invoices: Row[] = []
  const payments: Row[] = []
  let seq = 0
  const nextId = (p: string) => `${p}_${(seq += 1)}`

  const db = {
    stripeCustomer: {
      findUnique: ({ where }: { where: { stripeCustomerId: string } }) =>
        Promise.resolve(
          stripeCustomers.find((c) => c['stripeCustomerId'] === where.stripeCustomerId) ?? null,
        ),
    },
    invoice: {
      findUnique: ({ where }: { where: { externalId: string } }) =>
        Promise.resolve(invoices.find((i) => i['externalId'] === where.externalId) ?? null),
    },
    payment: {
      findUnique: ({ where }: { where: { externalId: string } }) =>
        Promise.resolve(payments.find((p) => p['externalId'] === where.externalId) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: (data['id'] as string) ?? nextId('pay') } as Row
        payments.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = payments.find((p) => p.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, payments }
}

const baseInput = {
  stripeChargeId: 'ch_1',
  stripeCustomerId: 'cus_known',
  amountMinor: 12000,
  currency: 'GBP',
  receivedAt: new Date('2026-06-01T10:00:00Z'),
}

describe('syncStripePayment', () => {
  it('records a payment against the resolved family', async () => {
    const { db, payments } = makeFakeDb({ linkedCustomer: 'cus_known' })
    const result = await syncStripePayment(db, baseInput)
    expect(result).toMatchObject({ familyId: 'fam_1', unresolved: false, created: true })
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ provider: 'stripe', externalId: 'ch_1', familyId: 'fam_1' })
  })

  it('is idempotent on the charge id', async () => {
    const { db, payments } = makeFakeDb({ linkedCustomer: 'cus_known' })
    await syncStripePayment(db, baseInput)
    const second = await syncStripePayment(db, baseInput)
    expect(second.created).toBe(false)
    expect(payments).toHaveLength(1)
  })

  it('returns unresolved when no StripeCustomer maps to a Family', async () => {
    const { db, payments } = makeFakeDb({ linkedCustomer: null })
    const result = await syncStripePayment(db, baseInput)
    expect(result.unresolved).toBe(true)
    expect(payments).toHaveLength(0)
  })
})

describe('revertStripePayment', () => {
  it('marks an existing payment reverted (idempotently)', async () => {
    const { db, payments } = makeFakeDb({ linkedCustomer: 'cus_known' })
    await syncStripePayment(db, baseInput)
    const first = await revertStripePayment(db, { stripeChargeId: 'ch_1', revertedAt: new Date() })
    expect(first).toMatchObject({ missing: false, alreadyReverted: false })
    expect(payments[0]).toMatchObject({ reverted: true })
    const second = await revertStripePayment(db, { stripeChargeId: 'ch_1', revertedAt: new Date() })
    expect(second.alreadyReverted).toBe(true)
  })

  it('reports missing when the charge was never recorded', async () => {
    const { db } = makeFakeDb({ linkedCustomer: 'cus_known' })
    const result = await revertStripePayment(db, { stripeChargeId: 'ch_unseen', revertedAt: new Date() })
    expect(result.missing).toBe(true)
  })
})
