// Call summary domain tests. Self-contained in-memory fake DB that implements
// only the Prisma surface addCallSummary touches.

import { describe, expect, it } from 'vitest'

import { addCallSummary } from './call-summary'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const cards: Row[] = []
  const contacts: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string }> = []

  const db = {
    card: {
      findFirst: async ({ where }: { where: Row }) =>
        cards.find((c) => c.id === where.id && c.archivedAt == null) ?? null,
    },
    contact: {
      findFirst: async ({ where }: { where: Row }) =>
        contacts.find((c) => c.id === where.id && c.deletedAt == null) ?? null,
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
      findFirst: async ({ where }: { where: Row }) =>
        interactions.find(
          (i) =>
            i.id === where.id &&
            (where.type === undefined || i.type === where.type) &&
            i.deletedAt == null,
        ) ?? null,
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id?: string; action: string } }) => {
        audits.push({ action: data.action })
        return { id: data.id ?? 'audit' }
      },
    },
  }

  return { db: db as never, cards, contacts, interactions, audits }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

function seed(t: ReturnType<typeof makeDb>) {
  t.cards.push({ id: 'card1', contactId: 'c1', archivedAt: null })
  t.contacts.push({ id: 'c1', firstName: 'Test', lastName: 'Parent', deletedAt: null })
}

describe('addCallSummary', () => {
  it('writes a call_summary Interaction on the contact and audits', async () => {
    const t = makeDb()
    seed(t)
    const result = await addCallSummary(
      t.db,
      { cardId: 'card1', authorId: 'u1', body: 'Spoke to parent, will call back', outcome: 'answered' },
      ctx,
    )
    expect(result.contactId).toBe('c1')
    expect(result.outcome).toBe('answered')
    const created = t.interactions.find((i) => i.type === 'call_summary')
    expect(created).toBeDefined()
    expect((created!.payload as Row).body).toContain('Spoke to parent')
    expect(t.audits.some((a) => a.action === 'card.call_summary_added')).toBe(true)
  })

  it('rejects an empty summary', async () => {
    const t = makeDb()
    seed(t)
    await expect(
      addCallSummary(t.db, { cardId: 'card1', authorId: 'u1', body: '   ' }, ctx),
    ).rejects.toMatchObject({ code: 'CALL_SUMMARY_EMPTY' })
  })

  it('rejects an unknown card', async () => {
    const t = makeDb()
    await expect(
      addCallSummary(t.db, { cardId: 'nope', authorId: 'u1', body: 'hi' }, ctx),
    ).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' })
  })
})
