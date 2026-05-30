// Card sub-task domain tests. Self-contained in-memory fake DB mirroring the
// pattern in call-summary.test.ts / forward.test.ts.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import {
  addCardSubtask,
  deleteCardSubtask,
  listCardSubtasks,
  updateCardSubtask,
} from './subtasks'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const cards: Row[] = []
  const subtasks: Row[] = []

  const db = {
    card: {
      findFirst: async ({ where }: { where: Row }) =>
        cards.find((c) => c.id === where.id && c.archivedAt == null) ?? null,
    },
    cardSubtask: {
      findMany: async ({ where }: { where: Row }) =>
        subtasks
          .filter((s) => s.cardId === where.cardId)
          .sort((a, b) => (a.position as number) - (b.position as number)),
      aggregate: async ({ where }: { where: Row }) => {
        const rows = subtasks.filter((s) => s.cardId === where.cardId)
        const max = rows.reduce((m, r) => Math.max(m, r.position as number), 0)
        return { _max: { position: max } }
      },
      findUnique: async ({ where }: { where: Row }) =>
        subtasks.find((s) => s.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        // Mirror the DB default for `completed` (schema: @default(false)).
        const row = { completed: false, ...data }
        subtasks.push(row)
        return { ...row }
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = subtasks.find((s) => s.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return { ...row }
      },
      delete: async ({ where }: { where: Row }) => {
        const idx = subtasks.findIndex((s) => s.id === where.id)
        if (idx >= 0) subtasks.splice(idx, 1)
        return {}
      },
    },
  }
  return { db: db as never, cards, subtasks }
}

function seed(t: ReturnType<typeof makeDb>) {
  t.cards.push({ id: 'card1', archivedAt: null })
}

describe('addCardSubtask', () => {
  it('appends sub-tasks with incrementing positions', async () => {
    const t = makeDb()
    seed(t)
    const a = await addCardSubtask(t.db, { cardId: 'card1', title: 'Call back', actorId: 'u1' })
    const b = await addCardSubtask(t.db, { cardId: 'card1', title: 'Email quote', actorId: 'u1' })
    expect(a.position).toBe(1)
    expect(b.position).toBe(2)
    expect(a.completed).toBe(false)
  })

  it('rejects an empty title', async () => {
    const t = makeDb()
    seed(t)
    await expect(
      addCardSubtask(t.db, { cardId: 'card1', title: '   ', actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'SUBTASK_EMPTY' })
  })

  it('rejects an over-long title', async () => {
    const t = makeDb()
    seed(t)
    await expect(
      addCardSubtask(t.db, { cardId: 'card1', title: 'x'.repeat(281), actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'SUBTASK_TOO_LONG' })
  })

  it('rejects an unknown card', async () => {
    const t = makeDb()
    await expect(
      addCardSubtask(t.db, { cardId: 'nope', title: 'hi', actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' })
  })
})

describe('updateCardSubtask', () => {
  it('toggles completion', async () => {
    const t = makeDb()
    seed(t)
    const a = await addCardSubtask(t.db, { cardId: 'card1', title: 'Call back', actorId: 'u1' })
    const updated = await updateCardSubtask(t.db, { id: a.id, completed: true, actorId: 'u1' })
    expect(updated.completed).toBe(true)
  })

  it('renames', async () => {
    const t = makeDb()
    seed(t)
    const a = await addCardSubtask(t.db, { cardId: 'card1', title: 'old', actorId: 'u1' })
    const updated = await updateCardSubtask(t.db, { id: a.id, title: 'new title', actorId: 'u1' })
    expect(updated.title).toBe('new title')
  })

  it('rejects a blank rename', async () => {
    const t = makeDb()
    seed(t)
    const a = await addCardSubtask(t.db, { cardId: 'card1', title: 'old', actorId: 'u1' })
    await expect(
      updateCardSubtask(t.db, { id: a.id, title: '  ', actorId: 'u1' }),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('rejects an unknown sub-task', async () => {
    const t = makeDb()
    await expect(
      updateCardSubtask(t.db, { id: 'nope', completed: true, actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'SUBTASK_NOT_FOUND' })
  })
})

describe('listCardSubtasks + deleteCardSubtask', () => {
  it('lists in position order and deletes', async () => {
    const t = makeDb()
    seed(t)
    const a = await addCardSubtask(t.db, { cardId: 'card1', title: 'one', actorId: 'u1' })
    await addCardSubtask(t.db, { cardId: 'card1', title: 'two', actorId: 'u1' })
    let list = await listCardSubtasks(t.db, 'card1')
    expect(list.map((s) => s.title)).toEqual(['one', 'two'])

    await deleteCardSubtask(t.db, a.id)
    list = await listCardSubtasks(t.db, 'card1')
    expect(list.map((s) => s.title)).toEqual(['two'])
  })

  it('delete rejects an unknown sub-task', async () => {
    const t = makeDb()
    await expect(deleteCardSubtask(t.db, 'nope')).rejects.toMatchObject({
      code: 'SUBTASK_NOT_FOUND',
    })
  })
})
