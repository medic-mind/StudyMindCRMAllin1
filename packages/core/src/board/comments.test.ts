// Card comment thread + description tests (slice A). Minimal in-memory fake
// DB covering only the surface the comment writers touch.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { addCardComment, listCardComments, setCardDescription } from './comments'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const cards: Row[] = []
  const users: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string }> = []

  const db = {
    card: {
      findFirst: async ({ where }: { where: Row }) =>
        cards.find((c) => c.id === where.id && c.archivedAt == null) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const c = cards.find((x) => x.id === where.id)
        if (!c) throw new Error('card not found')
        Object.assign(c, data)
        return c
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
      findMany: async ({ where }: { where: Row }) => {
        const ids = (where.id as { in: string[] }).in
        return users.filter((u) => ids.includes(u.id as string))
      },
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
      findMany: async ({ where }: { where: Row }) =>
        interactions.filter((i) => {
          if (i.type !== where.type) return false
          if (where.deletedAt === null && i.deletedAt != null) return false
          // Honour the JSONB `payload.path cardId equals` filter the query now
          // uses (server-side cardId filtering) — mirrors the real DB.
          const p = where.payload as { path?: string[]; equals?: unknown } | undefined
          if (p?.path?.[0] === 'cardId') {
            return (i.payload as { cardId?: unknown } | null)?.cardId === p.equals
          }
          return true
        }),
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id: string; action: string } }) => {
        audits.push({ action: data.action })
        return { id: data.id }
      },
    },
  }

  return { db: db as never, cards, users, interactions, audits }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

function seedCard(t: ReturnType<typeof makeDb>) {
  t.cards.push({ id: 'card1', contactId: 'c1', archivedAt: null, description: null })
  t.users.push({ id: 'u1', name: 'Alex Agent', email: 'alex@x.co' })
}

describe('addCardComment', () => {
  it('writes a card_comment interaction on the backing contact and audits', async () => {
    const t = makeDb()
    seedCard(t)
    const comment = await addCardComment(t.db, { cardId: 'card1', authorId: 'u1', body: '  hello  ' }, ctx)
    expect(comment.body).toBe('hello')
    expect(comment.authorName).toBe('Alex Agent')
    const written = t.interactions[0]!
    expect(written.type).toBe('card_comment')
    expect(written.contactId).toBe('c1')
    expect((written.payload as { body: string }).body).toBe('hello')
    expect(t.audits.some((a) => a.action === 'card.commented')).toBe(true)
  })

  it('rejects an empty comment', async () => {
    const t = makeDb()
    seedCard(t)
    await expect(
      addCardComment(t.db, { cardId: 'card1', authorId: 'u1', body: '   ' }, ctx),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('rejects a comment on a missing card', async () => {
    const t = makeDb()
    await expect(
      addCardComment(t.db, { cardId: 'nope', authorId: 'u1', body: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' })
  })
})

describe('listCardComments', () => {
  it('returns only this card comments, oldest first, with author names', async () => {
    const t = makeDb()
    seedCard(t)
    t.cards.push({ id: 'card2', contactId: 'c2', archivedAt: null, description: null })
    await addCardComment(t.db, { cardId: 'card1', authorId: 'u1', body: 'first' }, ctx)
    await addCardComment(t.db, { cardId: 'card2', authorId: 'u1', body: 'other card' }, ctx)
    await addCardComment(t.db, { cardId: 'card1', authorId: 'u1', body: 'second' }, ctx)
    const list = await listCardComments(t.db, { cardId: 'card1' })
    expect(list.map((c) => c.body)).toEqual(['first', 'second'])
    expect(list[0]!.authorName).toBe('Alex Agent')
  })
})

describe('setCardDescription', () => {
  it('stores the description, writes an interaction, and audits', async () => {
    const t = makeDb()
    seedCard(t)
    const result = await setCardDescription(t.db, { cardId: 'card1', description: '  needs follow up ' }, ctx)
    expect(result.description).toBe('needs follow up')
    expect(t.cards[0]!.description).toBe('needs follow up')
    expect(t.interactions.some((i) => i.type === 'card_description_changed')).toBe(true)
    expect(t.audits.some((a) => a.action === 'card.description_changed')).toBe(true)
  })

  it('clears the description when given an empty string', async () => {
    const t = makeDb()
    seedCard(t)
    t.cards[0]!.description = 'old'
    const result = await setCardDescription(t.db, { cardId: 'card1', description: '   ' }, ctx)
    expect(result.description).toBeNull()
    expect(t.cards[0]!.description).toBeNull()
  })
})
