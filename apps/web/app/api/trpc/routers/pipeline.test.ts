// pipeline router tests. ADR 0015. CLAUDE.md §27.
//
// Validates role gating on every mutation, the audit call on every
// successful write, and the BusinessError → TRPCError mapping for the
// archive flow.

import { describe, expect, it } from 'vitest'

import type {
  AuditCallInput,
  AuditRecorder,
  SessionUser,
  TrpcContext,
} from '@/lib/trpc/builders'

import { pipelineRouter } from './pipeline'

interface StageRow {
  id: string
  name: string
  position: number
  color: string
  isClosed: boolean
  archivedAt: Date | null
  createdAt: Date
}

interface FamilyRow {
  id: string
  stageId: string | null
  state: string | null
  deletedAt: Date | null
}

function makeAudit(): AuditRecorder {
  const fn = (async (_input: unknown) => {
    fn.called = true
    return 'audit_id'
  }) as unknown as AuditRecorder
  fn.called = false
  return fn
}

function makeCtx(
  role: SessionUser['role'],
  init: { stages?: StageRow[]; families?: FamilyRow[] } = {},
) {
  const stages: StageRow[] = init.stages ?? []
  const families: FamilyRow[] = init.families ?? []
  const audits: Array<{ action: string }> = []
  const originalAudit = makeAudit()
  const wrappedAudit = (async (input: AuditCallInput) => {
    audits.push({ action: input.action })
    return originalAudit(input)
  }) as unknown as AuditRecorder
  wrappedAudit.called = false
  Object.defineProperty(wrappedAudit, 'called', {
    get() {
      return originalAudit.called
    },
    set(v: boolean) {
      originalAudit.called = v
    },
  })

  const interactions: Array<{ type: string }> = []
  const auditRows: Array<{ action: string; actorId: string | null }> = []

  const db = {
    pipelineStage: {
      findMany: async ({
        where,
        orderBy: _orderBy,
        select: _select,
      }: {
        where?: { archivedAt?: null }
        orderBy?: unknown
        select?: unknown
      } = {}) => {
        if (where?.archivedAt === null) {
          return stages.filter((s) => s.archivedAt === null)
        }
        return [...stages]
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        stages.find((s) => s.id === where.id) ?? null,
      findFirst: async ({
        where,
      }: {
        where: {
          id?: { not: string }
          archivedAt?: null
          name?: { equals: string; mode: 'insensitive' }
        }
      }) =>
        stages.find((s) => {
          if (where.id && s.id === where.id.not) return false
          if (where.archivedAt === null && s.archivedAt !== null) return false
          if (
            where.name &&
            s.name.toLowerCase() !== where.name.equals.toLowerCase()
          )
            return false
          return true
        }) ?? null,
      create: async ({ data }: { data: Omit<StageRow, 'createdAt'> }) => {
        const row: StageRow = { ...data, createdAt: new Date() }
        stages.push(row)
        return row
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Partial<StageRow>
      }) => {
        const s = stages.find((x) => x.id === where.id)
        if (!s) throw new Error('not found')
        Object.assign(s, data)
        return s
      },
    },
    family: {
      count: async ({ where }: { where: { stageId: string } }) =>
        families.filter(
          (f) => f.stageId === where.stageId && f.deletedAt === null,
        ).length,
      updateMany: async ({
        where,
        data,
      }: {
        where: { stageId: string }
        data: { stageId: string }
      }) => {
        let n = 0
        for (const f of families) {
          if (f.stageId === where.stageId && f.deletedAt === null) {
            f.stageId = data.stageId
            n++
          }
        }
        return { count: n }
      },
      findFirst: async ({ where }: { where: { id: string } }) =>
        families.find(
          (f) => f.id === where.id && f.deletedAt === null,
        ) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Partial<FamilyRow>
      }) => {
        const f = families.find((x) => x.id === where.id)
        if (!f) throw new Error('not found')
        Object.assign(f, data)
        return f
      },
    },
    interaction: {
      create: async ({ data }: { data: { type: string } }) => {
        interactions.push(data)
        return data
      },
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({
        data,
      }: {
        data: { id: string; action: string; actorId: string | null }
      }) => {
        auditRows.push({ action: data.action, actorId: data.actorId })
        return { id: data.id }
      },
    },
    // Stages are board-scoped (ADR 0018): create binds to the default board,
    // archive cascades to the stage's cards.
    board: {
      findFirst: async () => ({ id: 'board_default' }),
    },
    card: {
      updateMany: async () => ({ count: 0 }),
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  }

  const ctx: TrpcContext = {
    user: { id: 'u1', email: 'u@x.com', role },
    requestId: 'req1',
    db: db as never,
    audit: wrappedAudit,
    headers: { origin: null, host: null },
  }
  return { ctx, stages, families, audits, interactions, auditRows }
}

function seedStages(): StageRow[] {
  return [
    {
      id: 's_lead',
      name: 'Lead',
      position: 1,
      color: 'blue-500',
      isClosed: false,
      archivedAt: null,
      createdAt: new Date(),
    },
    {
      id: 's_active',
      name: 'Active',
      position: 2,
      color: 'emerald-500',
      isClosed: false,
      archivedAt: null,
      createdAt: new Date(),
    },
  ]
}

describe('pipeline.stages.list', () => {
  it('returns active stages to any role', async () => {
    const { ctx } = makeCtx('virtual_assistant', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    const rows = await caller.stages.list()
    expect(rows.map((r) => r.id)).toEqual(['s_lead', 's_active'])
  })
})

describe('pipeline.stages.listIncludingArchived', () => {
  it('allows every staff role, incl. virtual_assistant (2026-07)', async () => {
    const { ctx } = makeCtx('virtual_assistant', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    const rows = await caller.stages.listIncludingArchived()
    expect(rows).toHaveLength(2)
  })

  it('allows senior_manager', async () => {
    const { ctx } = makeCtx('senior_manager', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    const rows = await caller.stages.listIncludingArchived()
    expect(rows).toHaveLength(2)
  })
})

describe('pipeline.stages.create', () => {
  it('allows every staff role, incl. virtual_assistant (2026-07)', async () => {
    const { ctx, stages } = makeCtx('virtual_assistant', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    const r = await caller.stages.create({ name: 'New', color: 'sky-500' })
    expect(r.position).toBe(3)
    expect(stages).toHaveLength(3)
  })

  it('auto-positions at end and audits', async () => {
    const { ctx, stages, audits } = makeCtx('ceo', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    const r = await caller.stages.create({ name: 'Renewal', color: 'sky-500' })
    expect(r.position).toBe(3)
    expect(stages).toHaveLength(3)
    expect(audits.map((a) => a.action)).toContain('pipeline.stage.created')
  })

  it('rejects duplicate name (case-insensitive)', async () => {
    const { ctx } = makeCtx('ceo', { stages: seedStages() })
    const caller = pipelineRouter.createCaller(ctx)
    await expect(
      caller.stages.create({ name: 'lead', color: 'blue-500' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('pipeline.stages.archive', () => {
  it('rejects when families remain and no reassign target is given', async () => {
    const { ctx } = makeCtx('senior_manager', {
      stages: seedStages(),
      families: [
        { id: 'f1', stageId: 's_lead', state: 'lead', deletedAt: null },
      ],
    })
    const caller = pipelineRouter.createCaller(ctx)
    await expect(
      caller.stages.archive({ id: 's_lead' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('reassigns families and archives when a target is given', async () => {
    const { ctx, stages, families, audits } = makeCtx('ceo', {
      stages: seedStages(),
      families: [
        { id: 'f1', stageId: 's_lead', state: 'lead', deletedAt: null },
        { id: 'f2', stageId: 's_lead', state: 'lead', deletedAt: null },
      ],
    })
    const caller = pipelineRouter.createCaller(ctx)
    const r = await caller.stages.archive({
      id: 's_lead',
      reassignFamiliesTo: 's_active',
    })
    expect(r.reassigned).toBe(2)
    expect(families.every((f) => f.stageId === 's_active')).toBe(true)
    expect(stages.find((s) => s.id === 's_lead')?.archivedAt).not.toBeNull()
    expect(audits.map((a) => a.action)).toContain('pipeline.stage.archived')
  })
})

describe('pipeline.family.move', () => {
  it('allows virtual_assistant (identical to sales_executive, 2026-07)', async () => {
    const { ctx, families } = makeCtx('virtual_assistant', {
      stages: seedStages(),
      families: [{ id: 'f1', stageId: 's_lead', state: 'lead', deletedAt: null }],
    })
    const caller = pipelineRouter.createCaller(ctx)
    const r = await caller.family.move({ familyId: 'f1', stageId: 's_active' })
    expect(r?.toStageId).toBe('s_active')
    expect(families[0]!.stageId).toBe('s_active')
  })

  it('allows sales_executive and writes interaction + audit row', async () => {
    const { ctx, families, interactions, auditRows } = makeCtx('sales_executive', {
      stages: seedStages(),
      families: [{ id: 'f1', stageId: 's_lead', state: 'lead', deletedAt: null }],
    })
    const caller = pipelineRouter.createCaller(ctx)
    const r = await caller.family.move({
      familyId: 'f1',
      stageId: 's_active',
    })
    expect(r?.toStageId).toBe('s_active')
    expect(families[0]!.stageId).toBe('s_active')
    expect(families[0]!.state).toBe('active')
    expect(interactions[0]!.type).toBe('family_pipeline_moved')
    expect(auditRows[0]!.action).toBe('family.pipeline_moved')
    expect(auditRows[0]!.actorId).toBe('u1')
  })
})
