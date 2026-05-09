// Tender persistence + state-machine glue tests. In-memory fake of the
// Prisma client (we are not testing Postgres). CLAUDE.md §43.1.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { createTender, getTenderById, transitionTender } from './index'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb() {
  const tenders: FakeRow[] = []
  const interactions: FakeRow[] = []
  const auditEntries: FakeRow[] = []

  const db = {
    tender: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        tenders.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(tenders.find((t) => t.id === where.id) ?? null),
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const t = tenders.find((row) => row.id === where.id)
        if (!t) return Promise.reject(new Error(`Tender ${where.id} not found`))
        return Promise.resolve(t)
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const t = tenders.find((row) => row.id === where.id)!
        Object.assign(t, data)
        return Promise.resolve(t)
      },
    },
    interaction: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        interactions.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditEntries.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
  }

  return { db: db as never, tenders, interactions, auditEntries }
}

const ACTOR = { actorId: 'user_1', requestId: 'req_1' }

describe('createTender', () => {
  it('creates a tender at identified, audits, and appends an interaction', async () => {
    const { db, tenders, interactions, auditEntries } = makeFakeDb()
    const { tenderId } = await createTender(
      db,
      {
        name: 'AP Inclusion 2026',
        laName: 'LB Camden',
        accountLeadId: 'user_1',
        isSemhOrEhcpHeavy: true,
      },
      ACTOR,
    )
    expect(tenders).toHaveLength(1)
    expect(tenders[0]?.['state']).toBe('identified')
    expect(tenders[0]?.['isSemhOrEhcpHeavy']).toBe(true)
    expect(interactions[0]?.['tenderId']).toBe(tenderId)
    expect(interactions[0]?.['type']).toBe('tender_state_changed')
    expect(auditEntries[0]?.['action']).toBe('tender.created')
  })
})

describe('transitionTender', () => {
  it('allows identified → drafting and writes interaction + audit', async () => {
    const fake = makeFakeDb()
    const { tenderId } = await createTender(
      fake.db,
      { name: 't', laName: 'la', accountLeadId: 'user_1' },
      ACTOR,
    )
    fake.interactions.length = 0
    fake.auditEntries.length = 0
    const result = await transitionTender(
      fake.db,
      { tenderId, to: 'drafting' },
      ACTOR,
    )
    expect(result).toEqual({ from: 'identified', to: 'drafting' })
    expect(fake.interactions[0]?.['type']).toBe('tender_state_changed')
    expect(fake.auditEntries[0]?.['action']).toBe('tender.state_changed')
  })

  it('rejects illegal transitions with BusinessError', async () => {
    const fake = makeFakeDb()
    const { tenderId } = await createTender(
      fake.db,
      { name: 't', laName: 'la', accountLeadId: 'user_1' },
      ACTOR,
    )
    await expect(
      transitionTender(fake.db, { tenderId, to: 'submitted' }, ACTOR),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('records outcome on terminal transitions', async () => {
    const fake = makeFakeDb()
    const { tenderId } = await createTender(
      fake.db,
      { name: 't', laName: 'la', accountLeadId: 'user_1' },
      ACTOR,
    )
    await transitionTender(fake.db, { tenderId, to: 'drafting' }, ACTOR)
    await transitionTender(fake.db, { tenderId, to: 'withdrawn', reason: 'lost interest' }, ACTOR)
    const t = fake.tenders[0]!
    expect(t['outcome']).toBe('withdrawn')
    expect(t['outcomeReason']).toBe('lost interest')
  })
})

describe('getTenderById', () => {
  it('returns null for unknown id', async () => {
    const fake = makeFakeDb()
    expect(await getTenderById(fake.db, 'nope')).toBeNull()
  })
})
