// Board domain tests (ADR 0018). Uses a minimal in-memory fake DB that
// implements only the Prisma surface the writers touch.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { archiveBoard, createBoard, ensureSingleDefault } from './boards'
import { createCard, moveCard } from './cards'
import { createLabel, deleteLabel } from './labels'
import { findOrCreateSubject } from './subjects'

interface Row {
  [k: string]: unknown
}

function matchInsensitive(value: unknown, eq: { equals: string; mode?: string }): boolean {
  return String(value ?? '').toLowerCase() === eq.equals.toLowerCase()
}

function makeDb() {
  const boards: Row[] = []
  const stages: Row[] = []
  const contacts: Row[] = []
  const cards: Row[] = []
  const labels: Row[] = []
  const cardLabels: Row[] = []
  const subjects: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string }> = []

  let seq = 0
  const nextId = (p: string) => `${p}_${++seq}`

  function aggregateMax(rows: Row[], where: Row, field: string): number | null {
    const filtered = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v))
    if (filtered.length === 0) return null
    return Math.max(...filtered.map((r) => Number(r[field] ?? 0)))
  }

  const db = {
    board: {
      aggregate: async ({ where }: { where: Row }) => ({
        _max: { position: aggregateMax(boards, where ?? {}, 'position') },
      }),
      findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row }) => {
        const matches = boards.filter((b) => {
          if (where.archivedAt === null && b.archivedAt != null) return false
          if (where.name && !matchInsensitive(b.name, where.name as never)) return false
          if (where.isDefault !== undefined && b.isDefault !== where.isDefault) return false
          if (where.id && typeof where.id === 'object' && 'not' in (where.id as Row)) {
            if (b.id === (where.id as { not: string }).not) return false
          } else if (where.id && b.id !== where.id) return false
          return true
        })
        if (orderBy && (orderBy as { position?: string }).position === 'asc') {
          matches.sort((a, b) => Number(a.position) - Number(b.position))
        }
        return matches[0] ?? null
      },
      findMany: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
        const matches = boards.filter((b) => {
          if (where?.isDefault !== undefined && b.isDefault !== where.isDefault) return false
          if (where?.archivedAt === null && b.archivedAt != null) return false
          return true
        })
        if (orderBy && (orderBy as { position?: string }).position === 'asc') {
          matches.sort((a, b) => Number(a.position) - Number(b.position))
        }
        return matches
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        boards.find((b) => b.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { archivedAt: null, ...data }
        boards.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const b = boards.find((x) => x.id === where.id)
        if (!b) throw new Error('board not found')
        Object.assign(b, data)
        return b
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let n = 0
        for (const b of boards) {
          if (where.isDefault !== undefined && b.isDefault !== where.isDefault) continue
          if (where.id && typeof where.id === 'object' && 'not' in (where.id as Row)) {
            if (b.id === (where.id as { not: string }).not) continue
          }
          Object.assign(b, data)
          n++
        }
        return { count: n }
      },
    },
    pipelineStage: {
      findFirst: async ({ where }: { where: Row }) =>
        stages.find((s) => {
          if (where.id && s.id !== where.id) return false
          if (where.boardId && s.boardId !== where.boardId) return false
          if (where.archivedAt === null && s.archivedAt !== null) return false
          return true
        }) ?? null,
    },
    contact: {
      findFirst: async ({ where }: { where: Row }) =>
        contacts.find((c) => c.id === where.id && c.deletedAt == null) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { ...data, deletedAt: null }
        contacts.push(row)
        return row
      },
    },
    subject: {
      findFirst: async ({ where }: { where: Row }) =>
        subjects.find((s) => (where.name ? matchInsensitive(s.name, where.name as never) : true)) ??
        null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        subjects.find((s) => s.id === where.id) ?? null,
      findMany: async () => [...subjects],
      create: async ({ data }: { data: Row }) => {
        const row = { ...data }
        subjects.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const s = subjects.find((x) => x.id === where.id)
        if (!s) throw new Error('subject not found')
        Object.assign(s, data)
        return s
      },
    },
    label: {
      findFirst: async ({ where }: { where: Row }) =>
        labels.find((l) => (where.name ? matchInsensitive(l.name, where.name as never) : true)) ??
        null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        labels.find((l) => l.id === where.id) ?? null,
      count: async ({ where }: { where: Row }) => {
        if (where.id && typeof where.id === 'object' && 'in' in (where.id as Row)) {
          const ids = (where.id as { in: string[] }).in
          return labels.filter((l) => ids.includes(l.id as string)).length
        }
        return labels.length
      },
      create: async ({ data }: { data: Row }) => {
        const row = { ...data }
        labels.push(row)
        return row
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = labels.findIndex((l) => l.id === where.id)
        if (i >= 0) labels.splice(i, 1)
        return {}
      },
    },
    card: {
      aggregate: async ({ where }: { where: Row }) => ({
        _max: {
          position: aggregateMax(
            cards.filter((c) => c.archivedAt == null),
            { boardId: where.boardId, stageId: where.stageId },
            'position',
          ),
        },
      }),
      findFirst: async ({ where }: { where: Row }) =>
        cards.find((c) => c.id === where.id && c.archivedAt == null) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        cards.filter(
          (c) =>
            c.archivedAt == null &&
            (where.boardId === undefined || c.boardId === where.boardId) &&
            (where.stageId === undefined || c.stageId === where.stageId),
        ),
      create: async ({ data }: { data: Row }) => {
        const { labels: _l, ...rest } = data
        const row = { ...rest, archivedAt: null }
        cards.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const c = cards.find((x) => x.id === where.id)
        if (!c) throw new Error('card not found')
        Object.assign(c, data)
        return c
      },
    },
    cardLabel: {
      count: async ({ where }: { where: Row }) =>
        cardLabels.filter((cl) => cl.labelId === where.labelId).length,
      deleteMany: async ({ where }: { where: Row }) => {
        for (let i = cardLabels.length - 1; i >= 0; i--) {
          if (cardLabels[i]!.cardId === where.cardId) cardLabels.splice(i, 1)
        }
        return { count: 0 }
      },
      createMany: async ({ data }: { data: Row[] }) => {
        cardLabels.push(...data)
        return { count: data.length }
      },
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id: string; action: string } }) => {
        audits.push({ action: data.action })
        return { id: data.id ?? nextId('audit') }
      },
    },
  }

  return {
    db: db as never,
    boards,
    stages,
    contacts,
    cards,
    labels,
    cardLabels,
    subjects,
    interactions,
    audits,
    nextId,
  }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

describe('createBoard / ensureSingleDefault', () => {
  it('promotes the first board to default automatically', async () => {
    const t = makeDb()
    const b = await createBoard(t.db, { name: 'Sales' }, ctx)
    expect(b.position).toBe(1)
    const stored = t.boards.find((x) => x.id === b.id)!
    expect(stored.isDefault).toBe(true)
  })

  it('keeps exactly one default when a second board claims it', async () => {
    const t = makeDb()
    const first = await createBoard(t.db, { name: 'Sales' }, ctx)
    const second = await createBoard(t.db, { name: 'Camp', isDefault: true }, ctx)
    const defaults = t.boards.filter((x) => x.isDefault === true)
    expect(defaults).toHaveLength(1)
    expect(defaults[0]!.id).toBe(second.id)
    expect(t.boards.find((x) => x.id === first.id)!.isDefault).toBe(false)
  })

  it('rejects a duplicate board name', async () => {
    const t = makeDb()
    await createBoard(t.db, { name: 'Sales' }, ctx)
    await expect(createBoard(t.db, { name: 'sales' }, ctx)).rejects.toBeInstanceOf(BusinessError)
  })

  it('refuses to archive the default board', async () => {
    const t = makeDb()
    const b = await createBoard(t.db, { name: 'Sales' }, ctx)
    await expect(archiveBoard(t.db, b.id, ctx)).rejects.toMatchObject({
      code: 'BOARD_IS_DEFAULT',
    })
  })

  it('ensureSingleDefault collapses multiple defaults to the lowest position', async () => {
    const t = makeDb()
    t.boards.push(
      { id: 'a', name: 'A', position: 2, isDefault: true, archivedAt: null },
      { id: 'b', name: 'B', position: 1, isDefault: true, archivedAt: null },
    )
    await ensureSingleDefault(t.db)
    expect(t.boards.filter((x) => x.isDefault === true)).toHaveLength(1)
    expect(t.boards.find((x) => x.isDefault === true)!.id).toBe('b')
  })
})

describe('findOrCreateSubject', () => {
  it('creates a new subject and audits subject.created', async () => {
    const t = makeDb()
    const s = await findOrCreateSubject(t.db, { name: 'Maths' }, ctx)
    expect(s.name).toBe('Maths')
    expect(t.audits.some((a) => a.action === 'subject.created')).toBe(true)
  })

  it('matches case-insensitively and does not create a duplicate', async () => {
    const t = makeDb()
    const first = await findOrCreateSubject(t.db, { name: 'Maths' }, ctx)
    const again = await findOrCreateSubject(t.db, { name: 'maths' }, ctx)
    expect(again.id).toBe(first.id)
    expect(t.subjects).toHaveLength(1)
  })
})

describe('createCard', () => {
  function seedBoardWithStage(t: ReturnType<typeof makeDb>) {
    t.boards.push({ id: 'b1', name: 'Sales', position: 1, isDefault: true, archivedAt: null })
    t.stages.push({ id: 's1', name: 'Lead', boardId: 'b1', archivedAt: null })
  }

  it('creates a card that makes a new contact via the shared validation path', async () => {
    const t = makeDb()
    seedBoardWithStage(t)
    const card = await createCard(
      t.db,
      {
        boardId: 'b1',
        stageId: 's1',
        contact: { contact: { kind: 'parent', firstName: 'Test', lastName: 'Family' } },
      },
      ctx,
    )
    expect(t.contacts).toHaveLength(1)
    expect(card.contactId).toBe(t.contacts[0]!.id)
    expect(t.audits.some((a) => a.action === 'contact.created')).toBe(true)
    expect(t.audits.some((a) => a.action === 'card.created')).toBe(true)
  })

  it('links an existing contact by id', async () => {
    const t = makeDb()
    seedBoardWithStage(t)
    t.contacts.push({ id: 'c9', deletedAt: null })
    const card = await createCard(
      t.db,
      { boardId: 'b1', stageId: 's1', contact: { contactId: 'c9' } },
      ctx,
    )
    expect(card.contactId).toBe('c9')
    expect(t.contacts).toHaveLength(1)
  })

  it('rejects a stage that is not on the board', async () => {
    const t = makeDb()
    seedBoardWithStage(t)
    await expect(
      createCard(t.db, { boardId: 'b1', stageId: 'nope', contact: { contactId: 'c9' } }, ctx),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_NOT_FOUND' })
  })
})

describe('moveCard', () => {
  it('moves a card and writes a card_moved interaction + audit', async () => {
    const t = makeDb()
    t.boards.push({ id: 'b1', name: 'Sales', position: 1, isDefault: true, archivedAt: null })
    t.stages.push(
      { id: 's1', name: 'Lead', boardId: 'b1', archivedAt: null },
      { id: 's2', name: 'Active', boardId: 'b1', archivedAt: null },
    )
    t.contacts.push({ id: 'c1', deletedAt: null })
    t.cards.push({
      id: 'card1',
      boardId: 'b1',
      stageId: 's1',
      contactId: 'c1',
      subjectId: null,
      position: 1,
      archivedAt: null,
    })
    const moved = await moveCard(t.db, { cardId: 'card1', toStageId: 's2' }, ctx)
    expect(moved.stageId).toBe('s2')
    expect(t.interactions.some((i) => i.type === 'card_moved')).toBe(true)
    expect(t.audits.some((a) => a.action === 'card.moved')).toBe(true)
  })

  it('resequences cards within a stage when toPosition is given (reorder persists)', async () => {
    const t = makeDb()
    t.boards.push({ id: 'b1', name: 'Sales', position: 1, isDefault: true, archivedAt: null })
    t.stages.push({ id: 's1', name: 'Lead', boardId: 'b1', archivedAt: null })
    for (const [id, position] of [
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ] as const) {
      t.contacts.push({ id: `c_${id}`, deletedAt: null })
      t.cards.push({
        id: id,
        boardId: 'b1',
        stageId: 's1',
        contactId: `c_${id}`,
        subjectId: null,
        position,
        archivedAt: null,
      })
    }
    // Move card 'c' (last) to position 1 (top of the same stage).
    const moved = await moveCard(t.db, { cardId: 'c', toStageId: 's1', toPosition: 1 }, ctx)
    expect(moved.position).toBe(1)
    const byId = (id: string) => t.cards.find((x) => x.id === id)!.position
    expect(byId('c')).toBe(1)
    expect(byId('a')).toBe(2)
    expect(byId('b')).toBe(3)
  })
})

describe('labels', () => {
  it('deletes an unused label but rejects one in use', async () => {
    const t = makeDb()
    const inUse = await createLabel(t.db, { name: 'B2C', color: 'blue-600' }, ctx)
    const unused = await createLabel(t.db, { name: 'B2B', color: 'violet-600' }, ctx)
    t.cardLabels.push({ cardId: 'card1', labelId: inUse.id })

    await expect(deleteLabel(t.db, inUse.id, ctx)).rejects.toMatchObject({ code: 'LABEL_IN_USE' })
    await deleteLabel(t.db, unused.id, ctx)
    expect(t.labels.map((l) => l.id)).toEqual([inUse.id])
  })

  it('rejects a duplicate label name', async () => {
    const t = makeDb()
    await createLabel(t.db, { name: 'B2C', color: 'blue-600' }, ctx)
    await expect(createLabel(t.db, { name: 'b2c', color: 'red-600' }, ctx)).rejects.toMatchObject({
      code: 'LABEL_NAME_TAKEN',
    })
  })
})
