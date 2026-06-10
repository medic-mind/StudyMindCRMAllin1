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
import { Prisma } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  addCallSummary,
  addCardComment,
  addCardSubtask,
  applyQuickAction,
  archiveBoard,
  archiveCard,
  deleteCard,
  BoardCreateInput,
  BoardQuickActionsInput,
  BoardReorderInput,
  BoardUpdateInput,
  CallSummaryAddInput,
  CallSummarySendInput,
  type CallSummarySenders,
  type ChannelResult,
  CardCreateInput,
  CardMoveInput,
  CardSetLabelsInput,
  CardSetSubjectInput,
  CardUpdateInput,
  createBoard,
  createCard,
  createLabel,
  deleteCardSubtask,
  deleteLabel,
  findOrCreateSubject,
  LabelCreateInput,
  listCardComments,
  listCardSubtasks,
  listQuickActions,
  setCardDescription,
  LabelUpdateInput,
  listLabels,
  listSubjects,
  moveCard,
  reorderBoards,
  sendCallSummary,
  setCardLabels,
  setCardSubject,
  setQuickActions,
  SubjectCreateInput,
  SubjectQueryInput,
  updateBoard,
  updateCard,
  updateCardSubtask,
  updateLabel,
} from '@studymind/core/board'
import {
  buildCallSummaryDraftPrompt,
  buildCallSummaryScaffold,
  CALL_SUMMARY_DRAFT_PROMPT_VERSION,
  CallSummaryDraftShape,
  runDraft,
} from '@studymind/ai'
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
// Hard-delete is irreversible and removes audit-adjacent state (labels +
// subtasks cascade). Restricted to Manager+ — same tier that owns refunds
// and other irreversible writes (CLAUDE.md §20.1, ADR 0014).
const CARD_DELETE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
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

function assertCardDelete(role: UserRole): void {
  if (!CARD_DELETE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager and above can permanently delete cards',
    })
  }
}

/**
 * Resolve the three flavours of attachment ref to {filename, contentType,
 * data} tuples. Returns at most one row per ref; skips refs whose
 * underlying row no longer exists rather than failing the whole send.
 */
async function resolveCallSummaryAttachments(
  db: import('@prisma/client').PrismaClient,
  refs: ReadonlyArray<{ kind: string; id: string }>,
): Promise<ReadonlyArray<{ filename: string; contentType: string; data: Buffer }>> {
  if (refs.length === 0) return []
  const out: Array<{ filename: string; contentType: string; data: Buffer }> = []
  for (const ref of refs) {
    if (ref.kind === 'contactDocument') {
      const row = await db.contactDocument.findUnique({
        where: { id: ref.id },
        select: { fileName: true, contentType: true, data: true },
      })
      if (row) out.push({ filename: row.fileName, contentType: row.contentType, data: row.data })
    } else if (ref.kind === 'uploadedInvoice') {
      const row = await db.uploadedInvoice.findUnique({
        where: { id: ref.id },
        select: { fileName: true, contentType: true, data: true },
      })
      if (row) out.push({ filename: row.fileName, contentType: row.contentType, data: row.data })
    } else if (ref.kind === 'callSummaryTemplatePdf') {
      const row = await db.callSummaryTemplate.findUnique({
        where: { id: ref.id },
        select: { pdfFileName: true, pdfContentType: true, pdfData: true },
      })
      if (row && row.pdfData && row.pdfContentType && row.pdfFileName) {
        out.push({
          filename: row.pdfFileName,
          contentType: row.pdfContentType,
          data: row.pdfData,
        })
      }
    }
  }
  return out
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
      case 'CALL_SUMMARY_EMPTY':
      case 'SUBTASK_EMPTY':
      case 'SUBTASK_TOO_LONG':
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
      case 'BOARD_NOT_FOUND':
      case 'CARD_NOT_FOUND':
      case 'CALL_SUMMARY_NOT_FOUND':
      case 'LABEL_NOT_FOUND':
      case 'SUBJECT_NOT_FOUND':
      case 'CONTACT_NOT_FOUND':
      case 'PIPELINE_STAGE_NOT_FOUND':
      case 'QUICK_ACTION_NOT_FOUND':
      case 'SUBTASK_NOT_FOUND':
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
  cardFields: true,
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

  // Configurable "card face" — which preview fields show on every card on this
  // board. Manager+ (same tier as board management). Empty array is stored as
  // null ("show all"). CLAUDE.md §6.4.
  setCardFields: auditedProcedure
    .input(z.object({ boardId: z.string(), fields: z.array(z.string()).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertBoardManage(user.role)
      const board = await ctx.db.board.findFirst({
        where: { id: input.boardId, archivedAt: null },
        select: { id: true, cardFields: true },
      })
      if (!board) throw new TRPCError({ code: 'NOT_FOUND', message: 'Board not found' })
      const value = input.fields.length > 0 ? input.fields : null
      await ctx.db.board.update({
        where: { id: input.boardId },
        data: { cardFields: value ?? Prisma.DbNull },
      })
      await ctx.audit({
        action: 'board.updated',
        target: { type: 'Board', id: input.boardId },
        before: { cardFields: board.cardFields },
        after: { cardFields: value },
      })
      return { ok: true }
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
          description: true,
          dueAt: true,
          scheduledCallAt: true,
          priority: true,
          assigneeId: true,
          assignee: { select: { id: true, name: true, email: true } },
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
        contactEmail: r.contact.email,
        contactPhone: r.contact.phoneE164,
        description: r.description,
        subject: r.subject ? { id: r.subject.id, name: r.subject.name } : null,
        labels: r.labels.map((l) => l.label),
        lastActivityAt: latestByContact.get(r.contact.id) ?? null,
        dueAt: r.dueAt,
        scheduledCallAt: r.scheduledCallAt,
        priority: r.priority,
        assigneeId: r.assigneeId,
        assigneeName: r.assignee?.name ?? null,
        assigneeEmail: r.assignee?.email ?? null,
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
        dueAt: true,
        scheduledCallAt: true,
        priority: true,
        assigneeId: true,
        assignee: { select: { id: true, name: true, email: true } },
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
      dueAt: card.dueAt,
      scheduledCallAt: card.scheduledCallAt,
      priority: card.priority,
      assigneeId: card.assigneeId,
      assigneeName: card.assignee?.name ?? null,
      assigneeEmail: card.assignee?.email ?? null,
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

  // Call summary (slice B). Add records a call_summary Interaction on the
  // backing contact; send fans it out to the enabled channels. Both gated to
  // sales_executive+ and audited via the domain writers.
  callSummary: router({
    // Which channels are actionable for this card right now — drives the
    // send popover's disabled checkboxes + reason tooltips.
    availability: protectedProcedure
      .input(z.object({ cardId: z.string() }))
      .query(async ({ ctx, input }) => {
        const card = await ctx.db.card.findFirst({
          where: { id: input.cardId, archivedAt: null },
          select: { contact: { select: { id: true, email: true, phoneE164: true } } },
        })
        if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' })
        const contactId = card.contact.id

        // Slack is actionable when an operator has configured at least one
        // channel option, or the legacy env channel is set (CLAUDE.md §12).
        const slackOptionCount = await ctx.db.slackChannelOption.count({
          where: { archivedAt: null },
        })
        const hasSlackChannel =
          slackOptionCount > 0 || Boolean(process.env['SLACK_ALERTS_CHANNEL_ID'])

        const hasPhone = Boolean(card.contact.phoneE164)
        const trengoConvo = hasPhone
          ? await ctx.db.interaction.findFirst({
              where: { contactId, type: 'message', deletedAt: null },
              select: { id: true },
            })
          : null

        const hasEmail = Boolean(card.contact.email)
        const mailbox = await ctx.db.gmailMailbox.findFirst({
          where: { agentId: ctx.user?.id ?? '', deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { agentId: true },
        })
        const emailThread =
          hasEmail && mailbox
            ? await ctx.db.interaction.findFirst({
                where: {
                  contactId,
                  type: { in: ['email_received', 'email_sent'] },
                  deletedAt: null,
                },
                select: { id: true },
              })
            : null

        return {
          slack: { available: hasSlackChannel },
          trengo: {
            available: hasPhone && Boolean(trengoConvo),
            hasPhone,
          },
          email: {
            available: hasEmail && Boolean(mailbox) && Boolean(emailThread),
            hasEmail,
            gmailConnected: Boolean(mailbox),
          },
        }
      }),

    add: auditedProcedure.input(CallSummaryAddInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCardWrite(user.role)
      try {
        const result = await addCallSummary(
          ctx.db,
          { cardId: input.cardId, authorId: user.id, body: input.body, outcome: input.outcome },
          { actorId: user.id, requestId: ctx.requestId },
        )
        ctx.audit.called = true
        return {
          id: result.id,
          contactId: result.contactId,
          cardId: result.cardId,
          body: result.body,
          outcome: result.outcome,
          occurredAt: result.occurredAt,
        }
      } catch (err) {
        mapBusinessError(err)
      }
    }),

    send: auditedProcedure.input(CallSummarySendInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCardWrite(user.role)
      // Wire the live channel senders (lazy-imports the integration clients).
      const { buildCallSummarySenders } = await import('@/lib/board/call-summary-senders')
      const senders: CallSummarySenders = buildCallSummarySenders({
        agentId: user.id,
        requestId: ctx.requestId,
      })
      // Resolve attachments to bytes when the agent picked any AND a customer
      // channel that can carry them is selected (WhatsApp / SMS / Trengo /
      // email — all upload + attach). Each ref kind comes from its own table;
      // bytes are inlined in Postgres for all three (ContactDocument /
      // UploadedInvoice / CallSummaryTemplate). Cap on the input keeps it sane.
      const wantsAttachments = Boolean(
        input.channels.email ||
          input.channels.whatsapp ||
          input.channels.sms ||
          input.channels.trengo,
      )
      const refs = wantsAttachments ? (input.emailAttachments ?? []) : []
      const attachments: Array<{ filename: string; contentType: string; data: Buffer }> = [
        ...(await resolveCallSummaryAttachments(ctx.db, refs)),
      ]
      // Device uploads (base64 from the agent's machine) — attached alongside
      // the resolved library files. ≤8 MB each.
      if (wantsAttachments) {
        for (const f of input.uploadedAttachments ?? []) {
          const data = Buffer.from(f.dataBase64, 'base64')
          if (data.byteLength === 0) continue
          if (data.byteLength > 8 * 1024 * 1024) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: `Attachment "${f.filename}" exceeds the 8 MB limit.`,
            })
          }
          attachments.push({ filename: f.filename, contentType: f.contentType, data })
        }
      }
      try {
        const results = await sendCallSummary(
          ctx.db,
          {
            summaryInteractionId: input.summaryInteractionId,
            channels: input.channels,
            slackChannelId: input.slackChannelId,
            attachments,
            senders,
          },
          { actorId: user.id, requestId: ctx.requestId },
        )
        ctx.audit.called = true
        // Return a plain per-channel result map for the UI toasts.
        const out: Partial<
          Record<'slack' | 'trengo' | 'whatsapp' | 'sms' | 'email', ChannelResult>
        > = results
        return out
      } catch (err) {
        mapBusinessError(err)
      }
    }),

    /**
     * AI-draft a 3–4 line call summary from the contact's most recent
     * call transcript. Mirrors contact.callSummary.draftFromCall so the
     * card modal can render the same "AI draft" button. Returns null-status
     * variants when there's no call or no transcript yet.
     */
    draftFromCall: protectedProcedure
      .input(z.object({ cardId: z.string() }))
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const card = await ctx.db.card.findFirst({
          where: { id: input.cardId, archivedAt: null },
          select: {
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                subjects: { include: { subject: { select: { name: true } } } },
              },
            },
          },
        })
        if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' })
        const contactId = card.contact.id
        const call = await ctx.db.interaction.findFirst({
          where: { contactId, type: 'call', deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          select: { id: true, occurredAt: true, payload: true },
        })
        const payload = (call?.payload ?? {}) as {
          transcriptText?: unknown
          outcome?: unknown
        }
        const transcript =
          typeof payload.transcriptText === 'string' ? payload.transcriptText.trim() : ''
        const contactName =
          [card.contact.firstName, card.contact.lastName].filter(Boolean).join(' ').trim() ||
          card.contact.email ||
          'there'
        const interests = (card.contact.subjects ?? [])
          .map((s) => s.subject.name)
          .filter((n): n is string => Boolean(n))
        const agent = await ctx.db.user.findUnique({
          where: { id: user.id },
          select: { name: true },
        })
        const outcomeRaw = typeof payload.outcome === 'string' ? payload.outcome : undefined
        const outcomeHint =
          outcomeRaw === 'answered' || outcomeRaw === 'voicemail' || outcomeRaw === 'no_answer'
            ? outcomeRaw
            : undefined
        const prompt = buildCallSummaryDraftPrompt({
          transcript,
          contactName,
          callerName: agent?.name ?? null,
          interests,
          outcomeHint,
        })
        // Always hand back usable text (deterministic scaffold on AI failure).
        try {
          const result = await runDraft({
            task: 'call_summary_draft',
            promptVersion: CALL_SUMMARY_DRAFT_PROMPT_VERSION,
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o-mini',
            temperature: 0.4,
            contentShape: CallSummaryDraftShape,
            contactId,
            ctx: { source: 'card.callSummary.draftFromCall' },
          })
          return {
            status: 'ok' as const,
            text: result.text,
            source: (transcript ? 'transcript' : 'scaffold') as 'transcript' | 'scaffold',
            outcomeHint: outcomeHint ?? null,
            callInteractionId: call?.id ?? null,
            callOccurredAt: call?.occurredAt ?? null,
          }
        } catch {
          return {
            status: 'ok' as const,
            text: buildCallSummaryScaffold(contactName, agent?.name ?? null, interests),
            source: 'scaffold' as const,
            outcomeHint: outcomeHint ?? null,
            callInteractionId: call?.id ?? null,
            callOccurredAt: call?.occurredAt ?? null,
          }
        }
      }),

    /**
     * Preview the call-summary fan-out before firing it. Returns the
     * recipient + composed text per channel so the UI can render a
     * "Send to X · Preview · Confirm" flow. Read-only — no Interactions
     * or audits written.
     */
    preview: protectedProcedure
      .input(
        z.object({
          cardId: z.string(),
          body: z.string().min(1).max(8000),
        }),
      )
      .query(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        const card = await ctx.db.card.findFirst({
          where: { id: input.cardId, archivedAt: null },
          select: {
            id: true,
            contact: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                phoneE164: true,
              },
            },
          },
        })
        if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Card not found' })
        const contact = card.contact
        const contactName =
          [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() ||
          contact.email ||
          'this contact'
        const appUrl = (
          process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
        ).replace(/\/$/, '')
        const composed = `Call summary for ${contactName}\n\n${input.body}\n\n${appUrl}/contacts/${contact.id}`

        const defaultSlackOption = await ctx.db.slackChannelOption.findFirst({
          where: { isDefault: true, archivedAt: null },
          select: { channelId: true },
        })
        const slackChannelId =
          defaultSlackOption?.channelId ?? process.env['SLACK_ALERTS_CHANNEL_ID'] ?? null

        // Trengo target — same lookup buildCallSummarySenders does.
        const recentMessage = contact.phoneE164
          ? await ctx.db.interaction.findFirst({
              where: { contactId: contact.id, type: 'message', deletedAt: null },
              orderBy: { occurredAt: 'desc' },
              select: { payload: true },
            })
          : null
        const trengoPayload = (recentMessage?.payload ?? {}) as Record<string, unknown>
        const trengoTicketId =
          typeof trengoPayload['ticketId'] === 'number'
            ? trengoPayload['ticketId']
            : null
        const trengoChannel =
          typeof trengoPayload['channel'] === 'string'
            ? (trengoPayload['channel'] as string)
            : null

        // Gmail target — most recent email thread + actor's mailbox.
        const recentEmail = contact.email
          ? await ctx.db.interaction.findFirst({
              where: {
                contactId: contact.id,
                type: { in: ['email_received', 'email_sent'] },
                deletedAt: null,
              },
              orderBy: { occurredAt: 'desc' },
              select: { payload: true, summary: true },
            })
          : null
        const emailPayload = (recentEmail?.payload ?? {}) as Record<string, unknown>
        const emailThreadId =
          typeof emailPayload['threadId'] === 'string'
            ? (emailPayload['threadId'] as string)
            : typeof emailPayload['gmailThreadId'] === 'string'
              ? (emailPayload['gmailThreadId'] as string)
              : null
        const emailSubject =
          typeof emailPayload['subject'] === 'string'
            ? (emailPayload['subject'] as string)
            : recentEmail?.summary ?? 'Call summary'
        const mailbox = await ctx.db.gmailMailbox.findFirst({
          where: { agentId: user.id, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { address: true },
        })

        return {
          composedText: composed,
          slack: slackChannelId
            ? { channelId: slackChannelId, body: composed }
            : null,
          trengo:
            contact.phoneE164 && trengoTicketId != null && trengoChannel
              ? {
                  phoneE164: contact.phoneE164,
                  ticketId: trengoTicketId,
                  channel: trengoChannel,
                  body: input.body,
                }
              : null,
          email:
            contact.email && mailbox && emailThreadId
              ? {
                  fromAddress: mailbox.address,
                  toAddress: contact.email,
                  threadId: emailThreadId,
                  subject: emailSubject,
                  body: input.body,
                }
              : null,
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

  // Hard-delete a card. Irreversible — CLAUDE.md §3 (no silent data
  // mutation; UI must confirm). Cascades labels + subtasks; preserves the
  // backing Contact and its timeline. Manager+ only.
  delete: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCardDelete(user.role)
      try {
        await deleteCard(ctx.db, input.id, { actorId: user.id, requestId: ctx.requestId })
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

  // Configurable per-board quick actions (replaces the legacy tick/X
  // single-action pair). Listing is open; firing requires card-write;
  // CRUD on the catalogue is Manager+ via the boardQuickAction router.
  quickActions: router({
    list: protectedProcedure
      .input(z.object({ boardId: z.string(), includeArchived: z.boolean().default(false) }))
      .query(async ({ ctx, input }) =>
        listQuickActions(ctx.db, input.boardId, { includeArchived: input.includeArchived }),
      ),
  }),

  /**
   * Fire a configurable quick action against a card. Adds the action's
   * comment template to the card (if set) and moves the card to the
   * action's target stage (possibly on a different board). Both writes
   * are audited via the domain functions; the procedure marks the
   * middleware happy.
   */
  applyQuickAction: auditedProcedure
    .input(z.object({ cardId: z.string(), quickActionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCardWrite(user.role)
      try {
        const result = await applyQuickAction(
          ctx.db,
          {
            cardId: input.cardId,
            quickActionId: input.quickActionId,
            actorUserId: user.id,
          },
          { actorId: user.id, requestId: ctx.requestId },
        )
        await ctx.audit({
          action: 'card.quick_action_applied',
          target: { type: 'Card', id: input.cardId },
          after: {
            quickActionId: input.quickActionId,
            targetStageId: result.targetStageId,
            targetBoardId: result.targetBoardId,
            commentId: result.commentId,
          },
        })
        return result
      } catch (err) {
        mapBusinessError(err)
      }
    }),

  // Card sub-tasks (Todoist-style checklist on the card). Listing is open
  // to any authenticated reader; mutations require card-write.
  subtasks: router({
    list: protectedProcedure
      .input(z.object({ cardId: z.string() }))
      .query(async ({ ctx, input }) => listCardSubtasks(ctx.db, input.cardId)),

    add: auditedProcedure
      .input(z.object({ cardId: z.string(), title: z.string().trim().min(1).max(280) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCardWrite(user.role)
        try {
          const result = await addCardSubtask(ctx.db, {
            cardId: input.cardId,
            title: input.title,
            actorId: user.id,
          })
          await ctx.audit({
            action: 'card.updated',
            target: { type: 'Card', id: input.cardId },
            after: { subtaskAdded: result.id, title: result.title },
          })
          return result
        } catch (err) {
          mapBusinessError(err)
        }
      }),

    update: auditedProcedure
      .input(
        z.object({
          id: z.string(),
          title: z.string().trim().min(1).max(280).optional(),
          completed: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCardWrite(user.role)
        try {
          const result = await updateCardSubtask(ctx.db, {
            id: input.id,
            title: input.title,
            completed: input.completed,
            actorId: user.id,
          })
          await ctx.audit({
            action: 'card.updated',
            target: { type: 'CardSubtask', id: input.id },
            after: { completed: result.completed, title: result.title },
          })
          return result
        } catch (err) {
          mapBusinessError(err)
        }
      }),

    delete: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCardWrite(user.role)
        try {
          await deleteCardSubtask(ctx.db, input.id)
          await ctx.audit({
            action: 'card.updated',
            target: { type: 'CardSubtask', id: input.id },
            before: { subtaskDeleted: input.id },
          })
          return { id: input.id }
        } catch (err) {
          mapBusinessError(err)
        }
      }),
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

// --- Board quick-action admin router --------------------------------------
// CRUD for the BoardQuickAction catalogue. Manager+ can manage; surfaced
// on /boards/[boardId]/settings.

const QuickActionCreateInput = z.object({
  boardId: z.string(),
  label: z.string().trim().min(1).max(60),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/u, 'Use #RRGGBB')
    .optional(),
  targetStageId: z.string(),
  commentTemplate: z.string().trim().max(2000).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const QuickActionUpdateInput = z.object({
  id: z.string(),
  label: z.string().trim().min(1).max(60).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/u, 'Use #RRGGBB')
    .nullish(),
  targetStageId: z.string().optional(),
  commentTemplate: z.string().trim().max(2000).nullish(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const QUICK_ACTION_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertCanManageQuickActions(role: UserRole): void {
  if (!QUICK_ACTION_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can manage quick-action buttons',
    })
  }
}

const boardQuickActionRouter = router({
  list: protectedProcedure
    .input(z.object({ boardId: z.string(), includeArchived: z.boolean().default(false) }))
    .query(async ({ ctx, input }) =>
      listQuickActions(ctx.db, input.boardId, { includeArchived: input.includeArchived }),
    ),

  create: auditedProcedure
    .input(QuickActionCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageQuickActions(user.role)
      const board = await ctx.db.board.findUnique({
        where: { id: input.boardId },
        select: { id: true, archivedAt: true },
      })
      if (!board) throw new TRPCError({ code: 'NOT_FOUND', message: 'Board not found' })
      const stage = await ctx.db.pipelineStage.findFirst({
        where: { id: input.targetStageId, archivedAt: null },
        select: { id: true, boardId: true },
      })
      if (!stage || !stage.boardId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Target stage not found' })
      }
      const id = createId()
      const row = await ctx.db.boardQuickAction.create({
        data: {
          id,
          boardId: input.boardId,
          label: input.label,
          color: input.color ?? null,
          targetStageId: input.targetStageId,
          targetBoardId: stage.boardId === input.boardId ? null : stage.boardId,
          commentTemplate: input.commentTemplate ?? null,
          sortOrder: input.sortOrder ?? 100,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'board.quick_action_created',
        target: { type: 'Board', id: input.boardId },
        after: { quickActionId: row.id, label: row.label },
      })
      return { id: row.id }
    }),

  update: auditedProcedure
    .input(QuickActionUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageQuickActions(user.role)
      const before = await ctx.db.boardQuickAction.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          boardId: true,
          label: true,
          color: true,
          targetStageId: true,
          targetBoardId: true,
          commentTemplate: true,
          sortOrder: true,
        },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      let targetBoardId = before.targetBoardId
      if (input.targetStageId !== undefined) {
        const stage = await ctx.db.pipelineStage.findFirst({
          where: { id: input.targetStageId, archivedAt: null },
          select: { id: true, boardId: true },
        })
        if (!stage || !stage.boardId) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Target stage not found' })
        }
        targetBoardId = stage.boardId === before.boardId ? null : stage.boardId
      }
      const after = await ctx.db.boardQuickAction.update({
        where: { id: input.id },
        data: {
          ...(input.label !== undefined ? { label: input.label } : {}),
          color: input.color,
          ...(input.targetStageId !== undefined
            ? { targetStageId: input.targetStageId, targetBoardId }
            : {}),
          commentTemplate: input.commentTemplate,
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'board.quick_action_updated',
        target: { type: 'Board', id: after.boardId },
        before,
        after,
      })
      return { id: after.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageQuickActions(user.role)
      const before = await ctx.db.boardQuickAction.findUnique({
        where: { id: input.id },
        select: { id: true, boardId: true, label: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.boardQuickAction.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'board.quick_action_archived',
        target: { type: 'Board', id: before.boardId },
        before,
      })
      return { id: input.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageQuickActions(user.role)
      const before = await ctx.db.boardQuickAction.findUnique({
        where: { id: input.id },
        select: { id: true, boardId: true, label: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.boardQuickAction.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'board.quick_action_restored',
        target: { type: 'Board', id: before.boardId },
        after: before,
      })
      return { id: input.id }
    }),
})

export { boardRouter, boardQuickActionRouter, cardRouter, labelRouter, subjectRouter }
