// Board / Card / Label / Subject tRPC router. ADR 0018. CLAUDE.md §27, §20.
//
// Role gates (UI mirrors these — §20):
//   - board.*           CEO + Senior Manager
//   - board.stages.*    CEO + Senior Manager (reuses pipeline stage CRUD,
//                       scoped to a boardId)
//   - card.* (writes)   Sales Executive and above (Virtual Assistant read-only)
//   - label.list/create Sales Executive and above; label.delete CEO + SM
//   - subject.*         Sales Executive and above
//
// Every write audits via the domain writers (writeAuditLogEntry in the same
// transaction); we flip ctx.audit.called so the auditedProcedure middleware
// is satisfied.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  addCardComment,
  archiveBoard,
  archiveCard,
  BoardCreateInput,
  BoardQuickActionsInput,
  BoardReorderInput,
  BoardUpdateInput,
  CardCreateInput,
  CardMoveInput,
  CardSetLabelsInput,
  CardSetSubjectInput,
  CardUpdateInput,
  createBoard,
  createCard,
  createLabel,
  deleteLabel,
  findOrCreateSubject,
  LabelCreateInput,
  listCardComments,
  setCardDescription,
  LabelUpdateInput,
  listLabels,
  listSubjects,
  moveCard,
  reorderBoards,
  setCardLabels,
  setCardSubject,
  setQuickActions,
  SubjectCreateInput,
  SubjectQueryInput,
  updateBoard,
  updateCard,
  updateLabel,
} from '@studymind/core/board'
import { displayNameOf } from '@studymind/core/contact'
import { BusinessError } from '@studymind/core/errors'

import { canArchiveStage, nextPosition, type PipelineStageRecord } from '@studymind/core/pipeline'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const BOARD_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['ceo', 'senior_manager'])
const CARD_WRITE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])
const LABEL_DELETE_ROLES = BOARD_MANAGE_ROLES

function assertBoardManage(role: UserRole): void {
  if (!BOARD_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO and Senior Manager can manage boards',
    })
  }
}

function assertCardWrite(role: UserRole): void {
  if (!CARD_WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your role cannot create or move cards',
    })
  }
}

function mapBusinessError(err: unknown): never {
  if (err instanceof BusinessError) {
    switch (err.code) {
      case 'BOARD_NAME_TAKEN':
      case 'LABEL_NAME_TAKEN':
      case 'BOARD_ARCHIVED':
      case 'BOARD_IS_DEFAULT':
      case 'LABEL_IN_USE':
      case 'PIPELINE_STAGE_HAS_FAMILIES':
      case 'PIPELINE_STAGE_NAME_TAKEN':
      case 'PIPELINE_STAGE_ARCHIVED':
      case 'INVALID_STATE_TRANSITION':
        throw new TRPCError({ code: 'CONFLICT', message: err.message })
      case 'COMMENT_EMPTY':
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
      case 'BOARD_NOT_FOUND':
      case 'CARD_NOT_FOUND':
      case 'LABEL_NOT_FOUND':
      case 'SUBJECT_NOT_FOUND':
      case 'CONTACT_NOT_FOUND':
      case 'PIPELINE_STAGE_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    }
  }
  throw err
}

// --- Board sub-router ------------------------------------------------------

const boardSelect = {
  id: true,
  name: true,
  description: true,
  position: true,
  isDefault: true,
  tickActionStageId: true,
  xActionStageId: true,
} as const

const boardStagesRouter = router({
  list: protectedProcedure.input(z.object({ boardId: z.string() })).query(({ ctx, input }) =>
    ctx.db.pipelineStage.findMany({
      where: { boardId: input.boardId, archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, position: true, color: true, isClosed: true },
    }),
  ),

  create: auditedProcedure
    .input(
      z.object({
        boardId: z.string(),
        name: z.string().trim().min(1).max(60),
        color: z.string().trim().min(1).max(32),
        isClosed: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)

      const all = await ctx.db.pipelineStage.findMany({
        where: { boardId: input.boardId },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
        },
      })
      const nameTaken = all.some(
        (s) => s.archivedAt === null && s.name.toLowerCase() === input.name.toLowerCase(),
      )
      if (nameTaken) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A stage with that name already exists' })
      }
      const position = nextPosition(all)
      const created = await ctx.db.pipelineStage.create({
        data: {
          id: createId(),
          boardId: input.boardId,
          name: input.name,
          color: input.color,
          position,
          isClosed: input.isClosed,
          createdById: user.id,
        },
        select: { id: true, name: true, position: true, color: true, isClosed: true },
      })
      await ctx.audit({
        action: 'pipeline.stage.created',
        target: { type: 'PipelineStage', id: created.id },
        before: null,
        after: { ...created, boardId: input.boardId },
      })
      return created
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().trim().min(1).max(60).optional(),
        color: z.string().trim().min(1).max(32).optional(),
        isClosed: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)
      const existing = await ctx.db.pipelineStage.findUnique({
        where: { id: input.id },
        select: { id: true, name: true, color: true, isClosed: true, boardId: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })

      if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = await ctx.db.pipelineStage.findFirst({
          where: {
            id: { not: input.id },
            boardId: existing.boardId,
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
        select: { id: true, name: true, position: true, color: true, isClosed: true },
      })
      await ctx.audit({
        action: 'pipeline.stage.updated',
        target: { type: 'PipelineStage', id: updated.id },
        before: { name: existing.name, color: existing.color, isClosed: existing.isClosed },
        after: updated,
      })
      return updated
    }),

  reorder: auditedProcedure
    .input(z.object({ boardId: z.string(), orderedIds: z.array(z.string()).min(1).max(50) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)
      const active = await ctx.db.pipelineStage.findMany({
        where: { boardId: input.boardId, archivedAt: null },
        select: { id: true },
        orderBy: { position: 'asc' },
      })
      const activeIds = new Set(active.map((s) => s.id))
      const dedup = new Set(input.orderedIds)
      if (
        input.orderedIds.length !== active.length ||
        dedup.size !== input.orderedIds.length ||
        input.orderedIds.some((id) => !activeIds.has(id))
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'orderedIds must contain every active stage id on this board exactly once',
        })
      }
      await ctx.db.$transaction(async (tx) => {
        for (let i = 0; i < active.length; i++) {
          await tx.pipelineStage.update({
            where: { id: active[i]!.id },
            data: { position: 1000 + i },
          })
        }
        for (let i = 0; i < input.orderedIds.length; i++) {
          await tx.pipelineStage.update({
            where: { id: input.orderedIds[i]! },
            data: { position: i + 1 },
          })
        }
      })
      await ctx.audit({
        action: 'pipeline.stage.reordered',
        target: { type: 'PipelineStage', id: input.boardId },
        before: { order: active.map((s) => s.id) },
        after: { order: input.orderedIds },
      })
      return { ok: true }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string(), reassignFamiliesTo: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)
      const target = await ctx.db.pipelineStage.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          name: true,
          position: true,
          color: true,
          isClosed: true,
          archivedAt: true,
          boardId: true,
        },
      })
      if (!target) throw new TRPCError({ code: 'NOT_FOUND' })

      const familiesOnStage = await ctx.db.family.count({
        where: { stageId: input.id, deletedAt: null },
      })
      const activeStages = await ctx.db.pipelineStage.findMany({
        where: { boardId: target.boardId, archivedAt: null },
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
        // Cards on this stage are archived alongside it — a stage with no
        // home would orphan its cards.
        await tx.card.updateMany({
          where: { stageId: input.id, archivedAt: null },
          data: { archivedAt: now },
        })
        await tx.pipelineStage.update({ where: { id: input.id }, data: { archivedAt: now } })
      })
      await ctx.audit({
        action: 'pipeline.stage.archived',
        target: { type: 'PipelineStage', id: input.id },
        before: { archivedAt: null, familiesOnStage },
        after: { archivedAt: now.toISOString(), reassignedTo: input.reassignFamiliesTo ?? null },
      })
      return { ok: true, reassigned: familiesOnStage }
    }),
})

const boardRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const boards = await ctx.db.board.findMany({
      where: { archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { ...boardSelect, _count: { select: { cards: { where: { archivedAt: null } } } } },
    })
    return boards.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      position: b.position,
      isDefault: b.isDefault,
      tickActionStageId: b.tickActionStageId,
      xActionStageId: b.xActionStageId,
      cardCount: b._count.cards,
    }))
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const board = await ctx.db.board.findFirst({
      where: { id: input.id, archivedAt: null },
      select: boardSelect,
    })
    if (!board) throw new TRPCError({ code: 'NOT_FOUND' })
    return board
  }),

  /** Convenience: the default board, used by the /pipeline redirect. */
  getDefault: protectedProcedure.query(async ({ ctx }) => {
    const board = await ctx.db.board.findFirst({
      where: { isDefault: true, archivedAt: null },
      select: { id: true },
      orderBy: { position: 'asc' },
    })
    if (!board) {
      const first = await ctx.db.board.findFirst({
        where: { archivedAt: null },
        select: { id: true },
        orderBy: { position: 'asc' },
      })
      if (!first) throw new TRPCError({ code: 'NOT_FOUND', message: 'No boards exist' })
      return first
    }
    return board
  }),

  create: auditedProcedure.input(BoardCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertBoardManage(user.role)
    try {
      const result = await createBoard(
        ctx.db,
        { name: input.name, description: input.description, isDefault: input.isDefault },
        { actorId: user.id, requestId: ctx.requestId },
      )
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  update: auditedProcedure.input(BoardUpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertBoardManage(user.role)
    try {
      const result = await updateBoard(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  reorder: auditedProcedure.input(BoardReorderInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertBoardManage(user.role)
    try {
      await reorderBoards(ctx.db, input.orderedIds, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return { ok: true }
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  archive: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertBoardManage(user.role)
    try {
      await archiveBoard(ctx.db, input.id, { actorId: user.id, requestId: ctx.requestId })
      ctx.audit.called = true
      return { ok: true }
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  setQuickActions: auditedProcedure
    .input(BoardQuickActionsInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)
      try {
        const result = await setQuickActions(ctx.db, input, {
          actorId: user.id,
          requestId: ctx.requestId,
        })
        ctx.audit.called = true
        return result
      } catch (err) {
        mapBusinessError(err)
      }
    }),

  stages: boardStagesRouter,
})

// --- Card sub-router -------------------------------------------------------

const cardRouter = router({
  /** Cards for a board, grouped by stage. Sales Executive and above + VA. */
  list: protectedProcedure
    .input(z.object({ boardId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.card.findMany({
        where: { boardId: input.boardId, archivedAt: null },
        orderBy: [{ stageId: 'asc' }, { position: 'asc' }],
        select: {
          id: true,
          stageId: true,
          position: true,
          subject: { select: { id: true, name: true } },
          contact: {
            select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
          },
          labels: { select: { label: { select: { id: true, name: true, color: true } } } },
          updatedAt: true,
        },
      })
      // Latest activity per backing contact (cheap follow-up query).
      const contactIds = [...new Set(rows.map((r) => r.contact.id))]
      const latest = await ctx.db.interaction.groupBy({
        by: ['contactId'],
        where: { contactId: { in: contactIds }, deletedAt: null },
        _max: { occurredAt: true },
      })
      const latestByContact = new Map<string, Date | null>(
        latest.map((l) => [l.contactId as string, l._max.occurredAt ?? null]),
      )
      return rows.map((r) => ({
        id: r.id,
        stageId: r.stageId,
        position: r.position,
        contactId: r.contact.id,
        contactName: displayNameOf(r.contact),
        subject: r.subject ? { id: r.subject.id, name: r.subject.name } : null,
        labels: r.labels.map((l) => l.label),
        lastActivityAt: latestByContact.get(r.contact.id) ?? null,
        updatedAt: r.updatedAt,
      }))
    }),

  /** Full card detail for the modal. Any authenticated role may read. */
  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const card = await ctx.db.card.findFirst({
      where: { id: input.id, archivedAt: null },
      select: {
        id: true,
        boardId: true,
        stageId: true,
        description: true,
        updatedAt: true,
        board: { select: { id: true, name: true } },
        stage: { select: { id: true, name: true, color: true } },
        subject: { select: { id: true, name: true } },
        contact: {
          select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
        },
        labels: { select: { label: { select: { id: true, name: true, color: true } } } },
      },
    })
    if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' })
    const lastActivity = await ctx.db.interaction.aggregate({
      where: { contactId: card.contact.id, deletedAt: null },
      _max: { occurredAt: true },
    })
    return {
      id: card.id,
      boardId: card.boardId,
      stageId: card.stageId,
      description: card.description,
      board: card.board,
      stage: card.stage,
      subject: card.subject,
      contactId: card.contact.id,
      contactName: displayNameOf(card.contact),
      contactEmail: card.contact.email,
      contactPhone: card.contact.phoneE164,
      labels: card.labels.map((l) => l.label),
      lastActivityAt: lastActivity._max.occurredAt ?? null,
      updatedAt: card.updatedAt,
    }
  }),

  comments: router({
    list: protectedProcedure
      .input(z.object({ cardId: z.string(), cursor: z.string().nullish() }))
      .query(async ({ ctx, input }) => {
        const comments = await listCardComments(ctx.db, { cardId: input.cardId })
        return comments.map((c) => ({
          id: c.id,
          body: c.body,
          authorId: c.authorId,
          authorName: c.authorName,
          occurredAt: c.occurredAt,
        }))
      }),

    add: auditedProcedure
      .input(z.object({ cardId: z.string(), body: z.string().trim().min(1).max(4000) }))
      .mutation(async ({ ctx, input }) => {
        // Any authenticated user may comment (incl. virtual_assistant).
        const user = requireUser(ctx)
        try {
          const comment = await addCardComment(
            ctx.db,
            { cardId: input.cardId, authorId: user.id, body: input.body },
            { actorId: user.id, requestId: ctx.requestId },
          )
          ctx.audit.called = true
          return {
            id: comment.id,
            body: comment.body,
            authorId: comment.authorId,
            authorName: comment.authorName,
            occurredAt: comment.occurredAt,
          }
        } catch (err) {
          mapBusinessError(err)
        }
      }),
  }),

  setDescription: auditedProcedure
    .input(z.object({ cardId: z.string(), description: z.string().max(4000).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCardWrite(user.role)
      try {
        const result = await setCardDescription(ctx.db, input, {
          actorId: user.id,
          requestId: ctx.requestId,
        })
        ctx.audit.called = true
        return result
      } catch (err) {
        mapBusinessError(err)
      }
    }),

  create: auditedProcedure.input(CardCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await createCard(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  move: auditedProcedure.input(CardMoveInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await moveCard(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  update: auditedProcedure.input(CardUpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await updateCard(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  archive: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      await archiveCard(ctx.db, input.id, { actorId: user.id, requestId: ctx.requestId })
      ctx.audit.called = true
      return { ok: true }
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  setLabels: auditedProcedure.input(CardSetLabelsInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      await setCardLabels(ctx.db, input, { actorId: user.id, requestId: ctx.requestId })
      ctx.audit.called = true
      return { ok: true }
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  setSubject: auditedProcedure.input(CardSetSubjectInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await setCardSubject(ctx.db, input, {
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

// --- Label sub-router ------------------------------------------------------

const labelRouter = router({
  list: protectedProcedure.query(({ ctx }) => listLabels(ctx.db)),

  create: auditedProcedure.input(LabelCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await createLabel(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  update: auditedProcedure.input(LabelUpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await updateLabel(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),

  delete: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    if (!LABEL_DELETE_ROLES.has(user.role)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only CEO and Senior Manager can delete labels',
      })
    }
    try {
      await deleteLabel(ctx.db, input.id, { actorId: user.id, requestId: ctx.requestId })
      ctx.audit.called = true
      return { ok: true }
    } catch (err) {
      mapBusinessError(err)
    }
  }),
})

// --- Subject sub-router ----------------------------------------------------

const subjectRouter = router({
  list: protectedProcedure
    .input(SubjectQueryInput)
    .query(({ ctx, input }) => listSubjects(ctx.db, { q: input.q })),

  findOrCreate: auditedProcedure.input(SubjectCreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCardWrite(user.role)
    try {
      const result = await findOrCreateSubject(ctx.db, input, {
        actorId: user.id,
        requestId: ctx.requestId,
      })
      // findOrCreate only audits when it creates; a hit performs no audited
      // write, so satisfy the middleware regardless.
      ctx.audit.called = true
      return result
    } catch (err) {
      mapBusinessError(err)
    }
  }),
})

export { boardRouter, cardRouter, labelRouter, subjectRouter }
