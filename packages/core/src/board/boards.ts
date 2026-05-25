// Board domain writers (ADR 0018). CEO + Senior Manager only (gated at the
// tRPC layer). Every write lands an AuditLogEntry in the same transaction.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

interface BoardSummary {
  id: string
  name: string
  description: string | null
  position: number
  isDefault: boolean
  tickActionStageId: string | null
  xActionStageId: string | null
}

const boardSelect = {
  id: true,
  name: true,
  description: true,
  position: true,
  isDefault: true,
  tickActionStageId: true,
  xActionStageId: true,
} as const

async function nextBoardPosition(db: Db): Promise<number> {
  const max = await db.board.aggregate({
    where: { archivedAt: null },
    _max: { position: true },
  })
  return (max._max.position ?? 0) + 1
}

/**
 * Ensures exactly one board has `isDefault = true`. When `keepDefaultId` is
 * given, that board becomes the sole default and all others are cleared.
 * When omitted, if no active board is default the lowest-position active
 * board is promoted. Idempotent.
 */
export async function ensureSingleDefault(db: Db, keepDefaultId?: string): Promise<void> {
  if (keepDefaultId) {
    await db.board.updateMany({
      where: { id: { not: keepDefaultId }, isDefault: true },
      data: { isDefault: false },
    })
    await db.board.update({
      where: { id: keepDefaultId },
      data: { isDefault: true },
    })
    return
  }
  const defaults = await db.board.findMany({
    where: { isDefault: true, archivedAt: null },
    select: { id: true, position: true },
    orderBy: { position: 'asc' },
  })
  if (defaults.length === 1) return
  if (defaults.length > 1) {
    const keep = defaults[0]!.id
    await db.board.updateMany({
      where: { id: { not: keep }, isDefault: true },
      data: { isDefault: false },
    })
    return
  }
  // No default — promote the lowest-position active board if one exists.
  const first = await db.board.findFirst({
    where: { archivedAt: null },
    select: { id: true },
    orderBy: { position: 'asc' },
  })
  if (first) {
    await db.board.update({ where: { id: first.id }, data: { isDefault: true } })
  }
}

export async function createBoard(
  db: Db,
  input: { name: string; description?: string; isDefault?: boolean },
  ctx: ActorCtx,
): Promise<BoardSummary> {
  const nameTaken = await db.board.findFirst({
    where: { archivedAt: null, name: { equals: input.name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (nameTaken) {
    throw new BusinessError('BOARD_NAME_TAKEN', 'A board with that name already exists')
  }
  const position = await nextBoardPosition(db)
  const id = createId()
  const created = await db.board.create({
    data: {
      id,
      name: input.name,
      description: input.description ?? null,
      position,
      isDefault: false,
      createdById: ctx.actorId,
    },
    select: boardSelect,
  })
  if (input.isDefault) {
    await ensureSingleDefault(db, id)
    created.isDefault = true
  } else {
    // First board ever created becomes the default if none exists.
    await ensureSingleDefault(db)
  }
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.created',
    target: { type: 'Board', id: created.id },
    before: null,
    after: created,
  })
  return created
}

export async function updateBoard(
  db: Db,
  input: {
    id: string
    name?: string
    description?: string | null
    isDefault?: boolean
  },
  ctx: ActorCtx,
): Promise<BoardSummary> {
  const existing = await db.board.findUnique({
    where: { id: input.id },
    select: boardSelect,
  })
  if (!existing) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found')

  if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
    const dup = await db.board.findFirst({
      where: {
        id: { not: input.id },
        archivedAt: null,
        name: { equals: input.name, mode: 'insensitive' },
      },
      select: { id: true },
    })
    if (dup) {
      throw new BusinessError('BOARD_NAME_TAKEN', 'A board with that name already exists')
    }
  }

  const updated = await db.board.update({
    where: { id: input.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    select: boardSelect,
  })
  if (input.isDefault === true) {
    await ensureSingleDefault(db, input.id)
    updated.isDefault = true
  }
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.updated',
    target: { type: 'Board', id: updated.id },
    before: existing,
    after: updated,
  })
  return updated
}

/**
 * Reorder active boards. Park every row out of range first to avoid
 * colliding with the partial unique index, then write final positions.
 */
export async function reorderBoards(
  db: Db,
  orderedIds: ReadonlyArray<string>,
  ctx: ActorCtx,
): Promise<void> {
  const active = await db.board.findMany({
    where: { archivedAt: null },
    select: { id: true, position: true },
    orderBy: { position: 'asc' },
  })
  const activeIds = new Set(active.map((b) => b.id))
  const dedup = new Set(orderedIds)
  if (
    orderedIds.length !== active.length ||
    dedup.size !== orderedIds.length ||
    orderedIds.some((id) => !activeIds.has(id))
  ) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      'orderedIds must contain every active board id exactly once',
    )
  }
  for (let i = 0; i < active.length; i++) {
    await db.board.update({
      where: { id: active[i]!.id },
      data: { position: 5000 + i },
    })
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await db.board.update({ where: { id: orderedIds[i]! }, data: { position: i + 1 } })
  }
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.updated',
    target: { type: 'Board', id: 'all' },
    before: { order: active.map((b) => b.id) },
    after: { order: [...orderedIds] },
  })
}

/**
 * Archive a board. The default board cannot be archived — promote another
 * board to default first. Cards/stages cascade-delete only on hard delete;
 * archive is a soft hide.
 */
export async function archiveBoard(db: Db, id: string, ctx: ActorCtx): Promise<void> {
  const board = await db.board.findUnique({
    where: { id },
    select: { id: true, isDefault: true, archivedAt: true },
  })
  if (!board) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found')
  if (board.archivedAt !== null) {
    throw new BusinessError('BOARD_ARCHIVED', 'Board is already archived')
  }
  if (board.isDefault) {
    throw new BusinessError(
      'BOARD_IS_DEFAULT',
      'Cannot archive the default board — set another board as default first',
    )
  }
  const now = new Date()
  await db.board.update({ where: { id }, data: { archivedAt: now } })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.archived',
    target: { type: 'Board', id },
    before: { archivedAt: null },
    after: { archivedAt: now.toISOString() },
  })
}

/** Configure the per-board tick/x quick-action target stages. */
export async function setQuickActions(
  db: Db,
  input: { boardId: string; tickStageId: string | null; xStageId: string | null },
  ctx: ActorCtx,
): Promise<BoardSummary> {
  const board = await db.board.findUnique({
    where: { id: input.boardId },
    select: boardSelect,
  })
  if (!board) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found')

  for (const stageId of [input.tickStageId, input.xStageId]) {
    if (stageId === null) continue
    const stage = await db.pipelineStage.findFirst({
      where: { id: stageId, boardId: input.boardId, archivedAt: null },
      select: { id: true },
    })
    if (!stage) {
      throw new BusinessError(
        'PIPELINE_STAGE_NOT_FOUND',
        'Quick-action stage must be an active stage on this board',
        { stageId },
      )
    }
  }

  const updated = await db.board.update({
    where: { id: input.boardId },
    data: {
      tickActionStageId: input.tickStageId,
      xActionStageId: input.xStageId,
    },
    select: boardSelect,
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.updated',
    target: { type: 'Board', id: input.boardId },
    before: {
      tickActionStageId: board.tickActionStageId,
      xActionStageId: board.xActionStageId,
    },
    after: {
      tickActionStageId: updated.tickActionStageId,
      xActionStageId: updated.xActionStageId,
    },
  })
  return updated
}
