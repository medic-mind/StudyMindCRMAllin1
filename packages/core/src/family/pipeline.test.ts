// moveFamily writer tests. ADR 0015.
//
// The writer is a tiny orchestrator over Prisma. We stub the four methods
// it touches (`family.findFirst`, `pipelineStage.findUnique`,
// `family.update`, `interaction.create`) plus `auditLogEntry.findFirst`
// and `auditLogEntry.create` so we can assert all four side effects in
// one shot.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'

import { moveFamily } from './pipeline'

interface StageRow {
  id: string
  name: string
  archivedAt: Date | null
}

interface FamilyRow {
  id: string
  stageId: string | null
  state: string | null
  deletedAt: Date | null
}

interface InteractionRow {
  id: string
  type: string
  familyId: string
  summary: string | null
  payload: unknown
}

interface AuditRow {
  id: string
  action: string
  targetType: string
  targetId: string
  actorId: string | null
  requestId: string | null
  before: unknown
  after: unknown
}

function makeDb(families: FamilyRow[], stages: StageRow[]) {
  const interactions: InteractionRow[] = []
  const audits: AuditRow[] = []

  const db = {
    family: {
      findFirst: async ({ where }: { where: { id: string; deletedAt: null } }) =>
        families.find(
          (f) => f.id === where.id && f.deletedAt === null,
        ) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string }
        data: Partial<FamilyRow> & { updatedById?: string }
      }) => {
        const f = families.find((x) => x.id === where.id)
        if (!f) throw new Error('family not found in stub')
        if (data.stageId !== undefined) f.stageId = data.stageId
        if (data.state !== undefined) f.state = data.state
        return f
      },
    },
    pipelineStage: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        stages.find((s) => s.id === where.id) ?? null,
    },
    interaction: {
      create: async ({ data }: { data: InteractionRow }) => {
        interactions.push(data)
        return data
      },
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: AuditRow }) => {
        audits.push(data)
        return { id: data.id }
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  }
  return { db: db as never, interactions, audits, families }
}

describe('moveFamily', () => {
  it('updates stageId, mirrors state, writes interaction + audit', async () => {
    const { db, interactions, audits, families } = makeDb(
      [{ id: 'fam1', stageId: 'stg_lead', state: 'lead', deletedAt: null }],
      [
        { id: 'stg_lead', name: 'Lead', archivedAt: null },
        { id: 'stg_active', name: 'Active', archivedAt: null },
      ],
    )

    const result = await moveFamily(db, {
      familyId: 'fam1',
      toStageId: 'stg_active',
      actorId: 'user1',
      requestId: 'req1',
    })

    expect(result.fromStageId).toBe('stg_lead')
    expect(result.toStageId).toBe('stg_active')
    expect(result.toState).toBe('active')
    expect(families[0]!.stageId).toBe('stg_active')
    expect(families[0]!.state).toBe('active')
    expect(interactions).toHaveLength(1)
    expect(interactions[0]!.type).toBe('family_pipeline_moved')
    expect(interactions[0]!.payload).toMatchObject({
      fromStageId: 'stg_lead',
      toStageId: 'stg_active',
      fromState: 'lead',
      toState: 'active',
    })
    expect(audits).toHaveLength(1)
    expect(audits[0]!.action).toBe('family.pipeline_moved')
    expect(audits[0]!.targetId).toBe('fam1')
    expect(audits[0]!.actorId).toBe('user1')
    expect(audits[0]!.requestId).toBe('req1')
  })

  it('leaves legacy state untouched when the stage name is custom', async () => {
    const { db, families } = makeDb(
      [{ id: 'fam1', stageId: 'stg_active', state: 'active', deletedAt: null }],
      [
        { id: 'stg_active', name: 'Active', archivedAt: null },
        { id: 'stg_renewal', name: 'Renewal pending', archivedAt: null },
      ],
    )

    const result = await moveFamily(db, {
      familyId: 'fam1',
      toStageId: 'stg_renewal',
      actorId: 'user1',
      requestId: 'req2',
    })

    expect(result.toStageId).toBe('stg_renewal')
    // mirror returns null; legacy state stays at 'active'
    expect(families[0]!.state).toBe('active')
    expect(result.toState).toBe('active')
  })

  it('rejects a missing family', async () => {
    const { db } = makeDb([], [{ id: 'stg_active', name: 'Active', archivedAt: null }])
    await expect(
      moveFamily(db, {
        familyId: 'nope',
        toStageId: 'stg_active',
        actorId: 'u',
        requestId: 'r',
      }),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('rejects a missing target stage', async () => {
    const { db } = makeDb(
      [{ id: 'fam1', stageId: null, state: null, deletedAt: null }],
      [],
    )
    await expect(
      moveFamily(db, {
        familyId: 'fam1',
        toStageId: 'nope',
        actorId: 'u',
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_NOT_FOUND' })
  })

  it('rejects an archived target stage', async () => {
    const { db } = makeDb(
      [{ id: 'fam1', stageId: null, state: null, deletedAt: null }],
      [{ id: 'stg_old', name: 'Old', archivedAt: new Date() }],
    )
    await expect(
      moveFamily(db, {
        familyId: 'fam1',
        toStageId: 'stg_old',
        actorId: 'u',
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'PIPELINE_STAGE_ARCHIVED' })
  })
})
