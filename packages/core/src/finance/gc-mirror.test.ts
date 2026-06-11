// Unit tests for the complete GoCardless provider mirror (ADR 0038).
// In-memory fake Prisma client, matching sync-gocardless.test.ts. The rules
// under test are the linking invariants: auto-link ONLY on a single
// unambiguous email match, never overwrite an existing link, and manual
// linking propagates the Family to unlinked mandates.

import { describe, expect, it } from 'vitest'

import {
  linkGcCustomer,
  pickUnambiguousContact,
  upsertGcCustomerMirror,
  upsertGcMandateMirror,
  upsertGcPayoutMirror,
  upsertGcSubscriptionMirror,
} from './gc-mirror'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: {
  contacts?: Array<{ id: string; email: string | null; deletedAt?: Date | null }>
  familyMembers?: Array<{ contactId: string; familyId: string }>
}) {
  const contacts = (opts.contacts ?? []).map((c) => ({ deletedAt: null, ...c }))
  const familyMembers = opts.familyMembers ?? []
  const gcCustomers: FakeRow[] = []
  const gcMandates: FakeRow[] = []
  const gcSubscriptions: FakeRow[] = []
  const gcPayouts: FakeRow[] = []

  const db = {
    contact: {
      findMany: ({
        where,
      }: {
        where: { email: { equals: string }; deletedAt: null }
      }) =>
        Promise.resolve(
          contacts
            .filter(
              (c) =>
                c.deletedAt === null &&
                (c.email ?? '').toLowerCase() === where.email.equals.toLowerCase(),
            )
            .map((c) => ({ id: c.id })),
        ),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(
          contacts.find((c) => c.id === where.id && c.deletedAt === null)
            ? { id: where.id }
            : null,
        ),
    },
    familyMember: {
      findFirst: ({ where }: { where: { contactId: string } }) => {
        const member = familyMembers.find((m) => m.contactId === where.contactId)
        return Promise.resolve(member ? { familyId: member.familyId } : null)
      },
    },
    gcCustomer: {
      findUnique: ({
        where,
      }: {
        where: { gcCustomerId: string }
      }) =>
        Promise.resolve(
          gcCustomers.find((c) => c['gcCustomerId'] === where.gcCustomerId) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data } as FakeRow
        gcCustomers.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = gcCustomers.find((c) => c.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
    gcMandate: {
      findUnique: ({ where }: { where: { gcMandateId: string } }) =>
        Promise.resolve(
          gcMandates.find((m) => m['gcMandateId'] === where.gcMandateId) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data } as FakeRow
        gcMandates.push(row)
        return Promise.resolve({ id: row.id })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = gcMandates.find((m) => m.id === where.id)!
        Object.assign(row, data)
        return Promise.resolve(row)
      },
      updateMany: ({
        where,
        data,
      }: {
        where: { gcCustomerId: string; familyId: null }
        data: Record<string, unknown>
      }) => {
        const rows = gcMandates.filter(
          (m) => m['gcCustomerId'] === where.gcCustomerId && m['familyId'] === null,
        )
        rows.forEach((r) => Object.assign(r, data))
        return Promise.resolve({ count: rows.length })
      },
    },
    gcSubscription: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { gcSubscriptionId: string }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        const existing = gcSubscriptions.find(
          (s) => s['gcSubscriptionId'] === where.gcSubscriptionId,
        )
        if (existing) {
          Object.assign(existing, update)
          return Promise.resolve({ id: existing.id })
        }
        const row = { ...create } as FakeRow
        gcSubscriptions.push(row)
        return Promise.resolve({ id: row.id })
      },
    },
    gcPayout: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { gcPayoutId: string }
        create: Record<string, unknown>
        update: Record<string, unknown>
      }) => {
        const existing = gcPayouts.find((p) => p['gcPayoutId'] === where.gcPayoutId)
        if (existing) {
          Object.assign(existing, update)
          return Promise.resolve({ id: existing.id })
        }
        const row = { ...create } as FakeRow
        gcPayouts.push(row)
        return Promise.resolve({ id: row.id })
      },
    },
    _state: { gcCustomers, gcMandates, gcSubscriptions, gcPayouts },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
  return db as any
}

describe('pickUnambiguousContact', () => {
  it('returns the single candidate', () => {
    expect(pickUnambiguousContact([{ id: 'c1', familyId: null }])).toEqual({
      id: 'c1',
      familyId: null,
    })
  })

  it('returns null for zero or multiple candidates (never auto-merge)', () => {
    expect(pickUnambiguousContact([])).toBeNull()
    expect(
      pickUnambiguousContact([
        { id: 'c1', familyId: null },
        { id: 'c2', familyId: 'f1' },
      ]),
    ).toBeNull()
  })
})

describe('upsertGcCustomerMirror', () => {
  it('auto-links on a single unambiguous email match', async () => {
    const db = makeFakeDb({
      contacts: [{ id: 'c1', email: 'parent@example.com' }],
      familyMembers: [{ contactId: 'c1', familyId: 'f1' }],
    })
    const result = await upsertGcCustomerMirror(db, {
      gcCustomerId: 'CU1',
      email: 'Parent@Example.com',
      autoMatch: true,
    })
    expect(result.autoLinked).toBe(true)
    expect(result.contactId).toBe('c1')
    expect(result.familyId).toBe('f1')
  })

  it('does not link when two contacts share the email', async () => {
    const db = makeFakeDb({
      contacts: [
        { id: 'c1', email: 'shared@example.com' },
        { id: 'c2', email: 'shared@example.com' },
      ],
    })
    const result = await upsertGcCustomerMirror(db, {
      gcCustomerId: 'CU2',
      email: 'shared@example.com',
      autoMatch: true,
    })
    expect(result.autoLinked).toBe(false)
    expect(result.contactId).toBeNull()
  })

  it('never overwrites an existing link on re-sync', async () => {
    const db = makeFakeDb({
      contacts: [{ id: 'c_other', email: 'new@example.com' }],
    })
    await upsertGcCustomerMirror(db, { gcCustomerId: 'CU3', email: 'old@example.com' })
    await linkGcCustomerSeed(db, 'CU3', 'c_manual')
    const result = await upsertGcCustomerMirror(db, {
      gcCustomerId: 'CU3',
      email: 'new@example.com',
      autoMatch: true,
    })
    expect(result.contactId).toBe('c_manual')
    expect(result.autoLinked).toBe(false)
  })
})

/** Directly stamp a link on the fake row (simulating an earlier manual link). */
async function linkGcCustomerSeed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
  db: any,
  gcCustomerId: string,
  contactId: string,
): Promise<void> {
  const row = await db.gcCustomer.findUnique({ where: { gcCustomerId } })
  await db.gcCustomer.update({ where: { id: row.id }, data: { contactId } })
}

describe('upsertGcMandateMirror', () => {
  it('creates a mandate without a Family link (complete mirror)', async () => {
    const db = makeFakeDb({})
    const result = await upsertGcMandateMirror(db, {
      gcMandateId: 'MD1',
      state: 'active',
      gcCustomerId: 'CU1',
    })
    expect(result.familyId).toBeNull()
    expect(db._state.gcMandates).toHaveLength(1)
  })

  it('fills a missing Family link but never overwrites one', async () => {
    const db = makeFakeDb({})
    await upsertGcMandateMirror(db, { gcMandateId: 'MD2', state: 'active', familyId: null })
    const filled = await upsertGcMandateMirror(db, {
      gcMandateId: 'MD2',
      state: 'active',
      familyId: 'f1',
    })
    expect(filled.familyId).toBe('f1')
    const kept = await upsertGcMandateMirror(db, {
      gcMandateId: 'MD2',
      state: 'active',
      familyId: 'f2',
    })
    expect(kept.familyId).toBe('f1')
    expect(db._state.gcMandates[0]['familyId']).toBe('f1')
  })

  it('fails closed on unknown states (keeps prior state)', async () => {
    const db = makeFakeDb({})
    await upsertGcMandateMirror(db, { gcMandateId: 'MD3', state: 'active' })
    await upsertGcMandateMirror(db, { gcMandateId: 'MD3', state: 'unknown' })
    expect(db._state.gcMandates[0]['state']).toBe('active')
  })
})

describe('upsertGcSubscriptionMirror', () => {
  it('is idempotent on the GoCardless subscription id', async () => {
    const db = makeFakeDb({})
    await upsertGcSubscriptionMirror(db, {
      gcSubscriptionId: 'SB1',
      status: 'active',
      amountMinor: 4000,
      currency: 'gbp',
      intervalUnit: 'monthly',
    })
    await upsertGcSubscriptionMirror(db, {
      gcSubscriptionId: 'SB1',
      status: 'cancelled',
      amountMinor: 4000,
      currency: 'gbp',
      intervalUnit: 'monthly',
    })
    expect(db._state.gcSubscriptions).toHaveLength(1)
    expect(db._state.gcSubscriptions[0]['status']).toBe('cancelled')
    expect(db._state.gcSubscriptions[0]['currency']).toBe('GBP')
  })
})

describe('upsertGcPayoutMirror', () => {
  it('is idempotent on the GoCardless payout id and stores status as text', async () => {
    const db = makeFakeDb({})
    await upsertGcPayoutMirror(db, {
      gcPayoutId: 'PO1',
      status: 'pending',
      amountMinor: 50_000,
      currency: 'gbp',
    })
    await upsertGcPayoutMirror(db, {
      gcPayoutId: 'PO1',
      status: 'paid',
      amountMinor: 50_000,
      currency: 'gbp',
      arrivalDate: new Date('2026-06-12T00:00:00Z'),
    })
    expect(db._state.gcPayouts).toHaveLength(1)
    expect(db._state.gcPayouts[0]['status']).toBe('paid')
    expect(db._state.gcPayouts[0]['currency']).toBe('GBP')
  })
})

describe('linkGcCustomer', () => {
  it('links a contact and propagates the family to unlinked mandates', async () => {
    const db = makeFakeDb({
      contacts: [{ id: 'c1', email: 'parent@example.com' }],
      familyMembers: [{ contactId: 'c1', familyId: 'f1' }],
    })
    await upsertGcCustomerMirror(db, { gcCustomerId: 'CU1', email: 'parent@example.com' })
    await upsertGcMandateMirror(db, {
      gcMandateId: 'MD1',
      state: 'active',
      gcCustomerId: 'CU1',
    })

    const result = await linkGcCustomer(db, { gcCustomerId: 'CU1', contactId: 'c1' })
    expect(result.ok).toBe(true)
    expect(result.familyId).toBe('f1')
    expect(result.linkedMandates).toBe(1)
    expect(db._state.gcMandates[0]['familyId']).toBe('f1')
  })

  it('clears the link when contactId is null', async () => {
    const db = makeFakeDb({ contacts: [{ id: 'c1', email: 'x@example.com' }] })
    await upsertGcCustomerMirror(db, { gcCustomerId: 'CU1', email: 'x@example.com' })
    await linkGcCustomer(db, { gcCustomerId: 'CU1', contactId: 'c1' })
    const result = await linkGcCustomer(db, { gcCustomerId: 'CU1', contactId: null })
    expect(result.ok).toBe(true)
    expect(result.contactId).toBeNull()
  })

  it('rejects an unknown customer or contact', async () => {
    const db = makeFakeDb({})
    expect((await linkGcCustomer(db, { gcCustomerId: 'CU_NONE', contactId: 'c1' })).reason).toBe(
      'customer_not_found',
    )
    await upsertGcCustomerMirror(db, { gcCustomerId: 'CU1' })
    expect((await linkGcCustomer(db, { gcCustomerId: 'CU1', contactId: 'ghost' })).reason).toBe(
      'contact_not_found',
    )
  })
})
