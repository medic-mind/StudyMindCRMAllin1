// Pipeline tRPC router. ADR 0015. CLAUDE.md §6.4, §27.
//
// Two sub-routers:
//   - pipeline.stages.*  — CRUD on the operator-managed stage list
//                          (CEO and Senior Manager only)
//   - pipeline.family.*  — per-family stage assignment
//                          (Sales Executive and above)
//
// Every write audits via ctx.audit. UI-visible permissions match the
// server gates (CLAUDE.md §20 — UI hides what the user cannot do).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { BusinessError } from '@studymind/core/errors'
import { moveFamily } from '@studymind/core/family'
import {
  assertUniquePosition,
  canArchiveStage,
  nextPosition,
  type PipelineStageRecord,
} from '@studymind/core/pipeline'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const STAGE_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
])

const FAMILY_MOVE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanManage(role: UserRole): void {
  if (!STAGE_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO and Senior Manager can manage pipeline stages',
    })
  }
}

function assertCanMove(role: UserRole): void {
  if (!FAMILY_MOVE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your role cannot move families on the pipeline',
    })
  }
}

function mapBusinessError(err: unknown): never {
  if (err instanceof BusinessError) {
    if (
      err.code === 'PIPELINE_STAGE_NAME_TAKEN' ||
      err.code === 'PIPELINE_STAGE_HAS_FAMILIES' ||
      err.code === 'PIPELINE_STAGE_ARCHIVED' ||
      err.code === 'INVALID_STATE_TRANSITION'
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message })
    }
    if (
      err.code === 'PIPELINE_STAGE_NOT_FOUND' ||
      err.code === 'CONTACT_NOT_FOUND'
    ) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
    }
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
  }
  throw err
}

const StageNameInput = z.string().trim().min(1).max(60)
const StageColorInput = z.string().trim().min(1).max(32)

const stagesRouter = router({
  /** Active stages ordered by position. Visible to everyone. */
  list: protectedProcedure.query(({ ctx }) =>
    ctx.db.pipelineStage.findMany({
      where: { archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        name: true,
        position: true,
        color: true,
        isClosed: true,
      },
    }),
  ),

  /** All stages including archived. CEO + Senior Manager only. */
  listIncludingArchived: protectedProcedure.query(({ ctx }) => {
    assertCanManage(requireUser(ctx).role)
    return ctx.db.pipelineStage.findMany({
      orderBy: [
        { archivedAt: 'asc' },
        { position: 'asc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        name: true,
        position: true,
        color: true,
        isClosed: true,
        archivedAt: true,
      },
    })
  }),

  create: auditedProcedure
    .input(
      z.object({
        name: StageNameInput,
        color: StageColorInput,
        position: z.number().int().min(1).max(999).optional(),
        isClosed: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)

      // Stages are board-scoped (ADR 0018). A stage created with a null board
      // never appears on any board, so bind the new stage to the default board
      // and scope the name/position checks to that board.
      const defaultBoard = await ctx.db.board.findFirst({
        where: { isDefault: true, archivedAt: null },
        orderBy: { position: 'asc' },
        select: { id: true },
      })
      if (!defaultBoard) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No default board configured' })
      }
      const all = await ctx.db.pipelineStage.findMany({
        where: { boardId: defaultBoard.id },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })

      // Reject duplicate name among active stages (case-insensitive).
      const nameTaken = all.some(
        (s) =>
          s.archivedAt === null &&
          s.name.toLowerCase() === input.name.toLowerCase(),
      )
      if (nameTaken) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A stage with that name already exists',
        })
      }

      const position = input.position ?? nextPosition(all)
      try {
        assertUniquePosition(all, position)
      } catch (err) {
        mapBusinessError(err)
      }

      const created = await ctx.db.pipelineStage.create({
        data: {
          id: createId(),
          name: input.name,
          color: input.color,
          position,
          isClosed: input.isClosed,
          boardId: defaultBoard.id,
          createdById: user.id,
        },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
        },
      })

      await ctx.audit({
        action: 'pipeline.stage.created',
        target: { type: 'PipelineStage', id: created.id },
        before: null,
        after: created,
      })
      return created
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        name: StageNameInput.optional(),
        color: StageColorInput.optional(),
        isClosed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)

      const existing = await ctx.db.pipelineStage.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })

      if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await ctx.db.pipelineStage.findFirst({
          where: {
            id: { not: input.id },
            archivedAt: null,
            name: { equals: input.name, mode: 'insensitive' },
          },
          select: { id: true },
        })
        if (dup) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A stage with that name already exists',
          })
        }
      }

      const updated = await ctx.db.pipelineStage.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.isClosed !== undefined ? { isClosed: input.isClosed } : {}),
        },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
        },
      })

      await ctx.audit({
        action: 'pipeline.stage.updated',
        target: { type: 'PipelineStage', id: updated.id },
        before: {
          name: existing.name,
          color: existing.color,
          isClosed: existing.isClosed,
        },
        after: updated,
      })
      return updated
    }),

  /**
   * Reorder active stages. The partial unique index on (position) WHERE
   * archivedAt IS NULL is the safety net; we sidestep collisions during
   * the update by bumping every row through an out-of-range parking
   * position first, then writing the final positions.
   */
  reorder: auditedProcedure
    .input(z.object({ orderedIds: z.array(z.string()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)

      const active = await ctx.db.pipelineStage.findMany({
        where: { archivedAt: null },
        select: { id: true, position: true },
        orderBy: { position: 'asc' },
      })
      const activeIds = new Set(active.map((s) => s.id))
      if (
        input.orderedIds.length !== active.length ||
        input.orderedIds.some((id) => !activeIds.has(id))
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'orderedIds must contain every active stage id exactly once',
        })
      }
      const dedup = new Set(input.orderedIds)
      if (dedup.size !== input.orderedIds.length) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'orderedIds contains duplicates',
        })
      }

      await ctx.db.$transaction(async (tx) => {
        // Park every row out of range to avoid colliding with the partial
        // unique index during the rewrite.
        for (let i = 0; i < active.length; i++) {
          const row = active[i]!
          await tx.pipelineStage.update({
            where: { id: row.id },
            data: { position: 1000 + i },
          })
        }
        for (let i = 0; i < input.orderedIds.length; i++) {
          const id = input.orderedIds[i]!
          await tx.pipelineStage.update({
            where: { id },
            data: { position: i + 1 },
          })
        }
      })

      await ctx.audit({
        action: 'pipeline.stage.reordered',
        target: { type: 'PipelineStage', id: 'all' },
        before: { order: active.map((s) => s.id) },
        after: { order: input.orderedIds },
      })
      return { ok: true }
    }),

  archive: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        reassignFamiliesTo: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)

      const target = await ctx.db.pipelineStage.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })

      const familiesOnStage = await ctx.db.family.count({
        where: { stageId: input.id, deletedAt: null },
      })

      const activeStages = await ctx.db.pipelineStage.findMany({
        where: { archivedAt: null },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })

      const targetRecord: PipelineStageRecord = {
        id: target.id,
        name: target.name,
        position: target.position,
        color: target.color,
        isClosed: target.isClosed,
        archivedAt: target.archivedAt,
      }

      try {
        canArchiveStage({
          stage: targetRecord,
          familiesOnStage,
          reassignToStageId: input.reassignFamiliesTo ?? null,
          activeStages,
        })
      } catch (err) {
        mapBusinessError(err)
      }

      const now = new Date()
      await ctx.db.$transaction(async (tx) => {
        if (familiesOnStage > 0 && input.reassignFamiliesTo) {
          await tx.family.updateMany({
            where: { stageId: input.id, deletedAt: null },
            data: { stageId: input.reassignFamiliesTo },
          })
        }
        // Archive the stage's board cards too (mirrors board.stages.archive).
        // Leaving them behind orphans live cards on an archived stage.
        await tx.card.updateMany({
          where: { stageId: input.id, archivedAt: null },
          data: { archivedAt: now },
        })
        await tx.pipelineStage.update({
          where: { id: input.id },
          data: { archivedAt: now },
        })
      })

      await ctx.audit({
        action: 'pipeline.stage.archived',
        target: { type: 'PipelineStage', id: input.id },
        before: { archivedAt: null, familiesOnStage },
        after: {
          archivedAt: now.toISOString(),
          reassignedTo: input.reassignFamiliesTo ?? null,
        },
      })
      return { ok: true, reassigned: familiesOnStage }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)

      const target = await ctx.db.pipelineStage.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, archivedAt: true },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })
      if (target.archivedAt === null) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Stage is not archived',
        })
      }

      // Restore at the end of the active list so we never collide with a
      // currently-active position.
      const allActive = await ctx.db.pipelineStage.findMany({
        where: { archivedAt: null },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })
      const newPosition = nextPosition(allActive)
      await ctx.db.pipelineStage.update({
        where: { id: input.id },
        data: { archivedAt: null, position: newPosition },
      })

      await ctx.audit({
        action: 'pipeline.stage.restored',
        target: { type: 'PipelineStage', id: input.id },
        before: { archivedAt: target.archivedAt.toISOString() },
        after: { archivedAt: null, position: newPosition },
      })
      return { ok: true }
    }),
})

const familyPipelineRouter = router({
  /**
   * Move a Family to a different PipelineStage. Audited.
   * Sales Executive and above. ADR 0015.
   */
  move: auditedProcedure
    .input(
      z.object({
        familyId: z.string(),
        stageId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanMove(user.role)

      // The writer audits via writeAuditLogEntry directly so the audit row
      // lands in the same transaction as the move. Flip the audit-called
      // flag so the auditedProcedure middleware does not flag the call.
      try {
        const result = await moveFamily(ctx.db, {
          familyId: input.familyId,
          toStageId: input.stageId,
          actorId: user.id,
          requestId: ctx.requestId,
        })
        ctx.audit.called = true
        return result
      } catch (err) {
        mapBusinessError(err)
      }
    }),
})

export const pipelineRouter = router({
  stages: stagesRouter,
  family: familyPipelineRouter,
})
