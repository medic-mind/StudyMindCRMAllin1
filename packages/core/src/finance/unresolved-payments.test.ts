// Unit tests for the unresolved-payments tray. Prisma is faked in-memory
// (same style as sync-gocardless / sync-stripe tests).

import { describe, expect, it } from 'vitest'

import {
  dismissUnresolvedStripePayment,
  listUnresolvedStripePayments,
  recordUnresolvedStripePayment,
  resolveUnresolvedStripePayment,
} from './unresolved-payments'

interface Row {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: { families?: string[] } = {}) {
  const families: Row[] = (opts.families ?? ['fam_1']).map((id) => ({ id, deletedAt: null }))
  const unresolved: Row[] = []
  const stripeCustomers: Row[] = []
  const payments: Row[] = []
  let seq = 0
  const nextId = () => `id_${(seq += 1)}`

  const db = {
    unresolvedStripePayment: {
      findUnique: ({ where }: { where: { id?: string; stripeChargeId?: string } }) =>
        Promise.resolve(
          unresolved.find(
            (r) =>
              (where.id && r.id === where.id) ||
              (where.stripeChargeId && r['stripeChargeId'] === where.stripeChargeId),
          ) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        // Emulate the Prisma column default so status-gated reads behave.
        const row = { status: 'pending', ...data } as unknown as Row
        unresolved.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = unresolved.find((r) => r.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
      findMany: () =>
        Promise.resolve(unresolved.filter((r) => r['status'] === 'pending')),
    },
    family: {
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(families.find((f) => f.id === where.id && f['deletedAt'] === null) ?? null),
    },
    stripeCustomer: {
      findUnique: ({ where }: { where: { stripeCustomerId: string } }) =>
        Promise.resolve(
          stripeCustomers.find((c) => c['stripeCustomerId'] === where.stripeCustomerId) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        stripeCustomers.push({ ...data } as Row)
        return Promise.resolve({ id: (data['id'] as string) ?? nextId() })
      },
    },
    payment: {
      findUnique: ({ where }: { where: { externalId: string } }) =>
        Promise.resolve(payments.find((p) => p['externalId'] === where.externalId) ?? null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, id: (data['id'] as string) ?? nextId() } as Row
        payments.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = payments.find((p) => p.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
    invoice: {
      findUnique: () => Promise.resolve(null),
    },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, unresolved, stripeCustomers, payments }
}

const charge = {
  stripeChargeId: 'ch_1',
  stripeCustomerId: 'cus_unknown',
  amountMinor: 9900,
  currency: 'GBP',
  receivedAt: new Date('2026-06-04T09:00:00Z'),
  customerEmail: 'new@example.org',
  customerName: 'New Payer',
  productHandles: ['ucat-course'],
}

describe('recordUnresolvedStripePayment', () => {
  it('records a pending row and is idempotent on the charge id', async () => {
    const { db, unresolved } = makeFakeDb()
    const first = await recordUnresolvedStripePayment(db, charge)
    expect(first.created).toBe(true)
    const second = await recordUnresolvedStripePayment(db, charge)
    expect(second.created).toBe(false)
    expect(unresolved).toHaveLength(1)
  })

  it('lists pending rows', async () => {
    const { db } = makeFakeDb()
    await recordUnresolvedStripePayment(db, charge)
    const rows = await listUnresolvedStripePayments(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.stripeChargeId).toBe('ch_1')
  })
})

describe('resolveUnresolvedStripePayment', () => {
  it('links to a family: creates the customer mapping, records the payment, marks resolved', async () => {
    const { db, unresolved, stripeCustomers, payments } = makeFakeDb({ families: ['fam_1'] })
    await recordUnresolvedStripePayment(db, charge)
    const id = unresolved[0]!.id as string

    const result = await resolveUnresolvedStripePayment(db, {
      id,
      familyId: 'fam_1',
      actorId: 'user_finance',
    })
    expect(result).toMatchObject({ ok: true, familyId: 'fam_1' })
    expect(stripeCustomers).toHaveLength(1)
    expect(stripeCustomers[0]).toMatchObject({ stripeCustomerId: 'cus_unknown', familyId: 'fam_1' })
    expect(payments).toHaveLength(1)
    expect(unresolved[0]).toMatchObject({ status: 'resolved', resolvedFamilyId: 'fam_1' })
  })

  it('rejects an unknown family', async () => {
    const { db, unresolved } = makeFakeDb({ families: ['fam_1'] })
    await recordUnresolvedStripePayment(db, charge)
    const id = unresolved[0]!.id as string
    const result = await resolveUnresolvedStripePayment(db, {
      id,
      familyId: 'fam_missing',
      actorId: 'u',
    })
    expect(result).toEqual({ ok: false, reason: 'family_not_found' })
  })

  it('does not re-resolve an already-resolved row', async () => {
    const { db, unresolved } = makeFakeDb({ families: ['fam_1'] })
    await recordUnresolvedStripePayment(db, charge)
    const id = unresolved[0]!.id as string
    await resolveUnresolvedStripePayment(db, { id, familyId: 'fam_1', actorId: 'u' })
    const again = await resolveUnresolvedStripePayment(db, { id, familyId: 'fam_1', actorId: 'u' })
    expect(again).toEqual({ ok: false, reason: 'not_pending' })
  })
})

describe('dismissUnresolvedStripePayment', () => {
  it('marks a pending row dismissed', async () => {
    const { db, unresolved } = makeFakeDb()
    await recordUnresolvedStripePayment(db, charge)
    const id = unresolved[0]!.id as string
    const result = await dismissUnresolvedStripePayment(db, {
      id,
      reason: 'test charge',
      actorId: 'u',
    })
    expect(result).toMatchObject({ ok: true })
    expect(unresolved[0]).toMatchObject({ status: 'dismissed', dismissReason: 'test charge' })
  })
})
