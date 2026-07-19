// Board router role-gating tests. ADR 0018. CLAUDE.md §20, §27.
//
// Focus: each mutation rejects the roles that must not call it, and a write
// audits. The domain logic itself is covered by packages/core/src/board.

import { describe, expect, it } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext } from '@/lib/trpc/builders'

import { boardRouter, cardRouter, labelRouter, subjectRouter } from './board'

function makeAudit(): { audit: AuditRecorder; actions: string[] } {
  const actions: string[] = []
  const fn = (async (input: { action: string }) => {
    actions.push(input.action)
    fn.called = true
    return 'audit_id'
  }) as unknown as AuditRecorder
  fn.called = false
  return { audit: fn, actions }
}

interface FakeState {
  boards: Record<string, unknown>[]
  stages: Record<string, unknown>[]
  contacts: Record<string, unknown>[]
  cards: Record<string, unknown>[]
  labels: Record<string, unknown>[]
}

function makeCtx(role: SessionUser['role'], state: Partial<FakeState> = {}) {
  const s: FakeState = {
    boards: state.boards ?? [],
    stages: state.stages ?? [],
    contacts: state.contacts ?? [],
    cards: state.cards ?? [],
    labels: state.labels ?? [],
  }
  const { audit, actions } = makeAudit()
  let seq = 0
  const nid = () => `id_${++seq}`

  const db = {
    board: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        s.boards.find((b) => (where.id ? b.id === where.id : true)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        s.boards.find((b) => b.id === where.id) ?? null,
      findMany: async () => s.boards,
      aggregate: async () => ({ _max: { position: s.boards.length } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { archivedAt: null, ...data }
        s.boards.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const b = s.boards.find((x) => x.id === where.id)!
        Object.assign(b, data)
        return b
      },
      updateMany: async () => ({ count: 0 }),
    },
    pipelineStage: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        s.stages.find((st) => st.id === where.id) ?? null,
    },
    contact: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        s.contacts.find((c) => c.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { deletedAt: null, ...data }
        s.contacts.push(row)
        return row
      },
    },
    card: {
      aggregate: async () => ({ _max: { position: 0 } }),
      findFirst: async ({ where }: { where: { id: string } }) =>
        s.cards.find((c) => c.id === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const { labels: _l, ...rest } = data
        const row = { archivedAt: null, ...rest }
        s.cards.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const c = s.cards.find((x) => x.id === where.id)!
        Object.assign(c, data)
        return c
      },
    },
    label: {
      findFirst: async () => null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        s.labels.find((l) => l.id === where.id) ?? null,
      count: async () => 0,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        s.labels.push({ ...data })
        return data
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const i = s.labels.findIndex((l) => l.id === where.id)
        if (i >= 0) s.labels.splice(i, 1)
        return {}
      },
    },
    cardLabel: {
      count: async () => 0,
      deleteMany: async () => ({ count: 0 }),
      createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
    },
    subject: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }),
    },
    interaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => data,
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id: string; action: string } }) => {
        actions.push(data.action)
        return { id: data.id ?? nid() }
      },
    },
  }

  const ctx: TrpcContext = {
    user: { id: 'u1', email: 'u@x.com', role },
    requestId: 'req1',
    db: db as never,
    audit,
    headers: { origin: null, host: null },
  }
  return { ctx, state: s, actions }
}

describe('board.create gating', () => {
  it('rejects manager and below', async () => {
    for (const role of ['manager', 'sales_executive', 'virtual_assistant'] as const) {
      const { ctx } = makeCtx(role)
      const caller = boardRouter.createCaller(ctx)
      await expect(caller.create({ name: 'X', isDefault: false })).rejects.toMatchObject({
        code: 'FORBIDDEN',
      })
    }
  })

  it('allows CEO and audits board.created', async () => {
    const { ctx, actions } = makeCtx('ceo')
    const caller = boardRouter.createCaller(ctx)
    const board = await caller.create({ name: 'Sales', isDefault: false })
    expect(board.name).toBe('Sales')
    expect(actions).toContain('board.created')
  })
})

describe('card.create gating', () => {
  function seed() {
    return {
      boards: [{ id: 'b1', name: 'B', position: 1, isDefault: true, archivedAt: null }],
      stages: [{ id: 's1', name: 'Lead', boardId: 'b1', archivedAt: null }],
      contacts: [{ id: 'c1', deletedAt: null }],
    }
  }

  it('allows virtual_assistant (identical to sales_executive, 2026-07)', async () => {
    const { ctx, actions } = makeCtx('virtual_assistant', seed())
    const caller = cardRouter.createCaller(ctx)
    const card = await caller.create({ boardId: 'b1', stageId: 's1', contact: { contactId: 'c1' } })
    expect(card.contactId).toBe('c1')
    expect(actions).toContain('card.created')
  })

  it('allows sales_executive and audits card.created', async () => {
    const { ctx, actions } = makeCtx('sales_executive', seed())
    const caller = cardRouter.createCaller(ctx)
    const card = await caller.create({ boardId: 'b1', stageId: 's1', contact: { contactId: 'c1' } })
    expect(card.contactId).toBe('c1')
    expect(actions).toContain('card.created')
  })
})

describe('card.move gating', () => {
  it('allows virtual_assistant and sales_executive to move cards, auditing card.moved', async () => {
    const makeSeed = () => ({
      boards: [{ id: 'b1', name: 'B', position: 1, isDefault: true, archivedAt: null }],
      stages: [
        { id: 's1', name: 'Lead', boardId: 'b1', archivedAt: null },
        { id: 's2', name: 'Active', boardId: 'b1', archivedAt: null },
      ],
      contacts: [{ id: 'c1', deletedAt: null }],
      cards: [
        {
          id: 'card1',
          boardId: 'b1',
          stageId: 's1',
          contactId: 'c1',
          subjectId: null,
          position: 1,
          archivedAt: null,
        },
      ],
    })
    const va = makeCtx('virtual_assistant', makeSeed())
    const vaMoved = await cardRouter.createCaller(va.ctx).move({ cardId: 'card1', toStageId: 's2' })
    expect(vaMoved.stageId).toBe('s2')
    expect(va.actions).toContain('card.moved')

    const se = makeCtx('sales_executive', makeSeed())
    const moved = await cardRouter.createCaller(se.ctx).move({ cardId: 'card1', toStageId: 's2' })
    expect(moved.stageId).toBe('s2')
    expect(se.actions).toContain('card.moved')
  })
})

describe('label.delete gating', () => {
  it('rejects sales_executive but allows senior_manager', async () => {
    const seed = { labels: [{ id: 'l1', name: 'B2C', color: 'blue-600' }] }
    const se = makeCtx('sales_executive', { labels: [...seed.labels] })
    await expect(labelRouter.createCaller(se.ctx).delete({ id: 'l1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })

    const sm = makeCtx('senior_manager', { labels: [...seed.labels] })
    await expect(labelRouter.createCaller(sm.ctx).delete({ id: 'l1' })).resolves.toEqual({
      ok: true,
    })
  })
})

describe('subject.findOrCreate gating', () => {
  it('allows virtual_assistant (identical to sales_executive, 2026-07)', async () => {
    const { ctx } = makeCtx('virtual_assistant')
    await expect(
      subjectRouter.createCaller(ctx).findOrCreate({ name: 'Maths' }),
    ).resolves.toMatchObject({ name: 'Maths' })
  })
})
