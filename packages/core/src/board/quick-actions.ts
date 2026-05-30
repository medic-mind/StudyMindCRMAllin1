// Configurable per-board quick-action buttons (CLAUDE.md §27). Each row
// in `BoardQuickAction` defines a clickable chip on every card on the
// board: it has a label, colour, target stage (optionally on a different
// board, for cross-pipeline routing), and an optional comment template
// that gets added to the card alongside the move.
//
// CRUD lives in the tRPC layer; this module owns the domain action
// (`applyQuickAction`) and the small list/get helpers. Manager+ manages
// the catalogue; anyone with card-write permission can trigger an action.

import type { Prisma, PrismaClient } from '@prisma/client'

import { BusinessError } from '../errors'

import { addCardComment } from './comments'
import { moveCard } from './cards'

export type Db = PrismaClient | Prisma.TransactionClient

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface QuickActionSummary {
  id: string
  boardId: string
  label: string
  color: string | null
  targetStageId: string
  targetBoardId: string | null
  targetBoardName: string | null
  targetStageName: string
  commentTemplate: string | null
  sortOrder: number
  archived: boolean
}

function summary(row: {
  id: string
  boardId: string
  label: string
  color: string | null
  targetStageId: string
  targetBoardId: string | null
  commentTemplate: string | null
  sortOrder: number
  archivedAt: Date | null
  targetStage: { id: string; name: string; boardId: string | null }
}): QuickActionSummary {
  return {
    id: row.id,
    boardId: row.boardId,
    label: row.label,
    color: row.color,
    targetStageId: row.targetStageId,
    targetBoardId: row.targetBoardId,
    // The target board may differ from row.boardId — surface it explicitly
    // so the UI can render a "→ Other board" hint.
    targetBoardName: null,
    targetStageName: row.targetStage.name,
    commentTemplate: row.commentTemplate,
    sortOrder: row.sortOrder,
    archived: row.archivedAt != null,
  }
}

export async function listQuickActions(
  db: Db,
  boardId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<QuickActionSummary[]> {
  const rows = await db.boardQuickAction.findMany({
    where: {
      boardId,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
    include: {
      targetStage: { select: { id: true, name: true, boardId: true } },
    },
  })
  // Resolve target board names in one extra query so the UI can show
  // "→ Sales pipeline" when a quick action routes off-board.
  const otherBoardIds = Array.from(
    new Set(
      rows
        .filter((r) => r.targetStage.boardId && r.targetStage.boardId !== r.boardId)
        .map((r) => r.targetStage.boardId as string),
    ),
  )
  const boardNames =
    otherBoardIds.length > 0
      ? await db.board.findMany({
          where: { id: { in: otherBoardIds } },
          select: { id: true, name: true },
        })
      : []
  const boardNameById = new Map(boardNames.map((b) => [b.id, b.name]))
  return rows.map((r) => {
    const base = summary(r)
    const otherBoardId =
      r.targetStage.boardId && r.targetStage.boardId !== r.boardId
        ? r.targetStage.boardId
        : null
    return {
      ...base,
      targetBoardName: otherBoardId ? (boardNameById.get(otherBoardId) ?? null) : null,
    }
  })
}

export async function getQuickAction(
  db: Db,
  id: string,
): Promise<QuickActionSummary | null> {
  const row = await db.boardQuickAction.findUnique({
    where: { id },
    include: {
      targetStage: { select: { id: true, name: true, boardId: true } },
    },
  })
  if (!row) return null
  return summary(row)
}

/**
 * Fire a quick action against a card: render the comment template,
 * append it as a card comment (if any), then move the card to the
 * action's target stage. The move is cross-board when the target stage
 * lives on a different board. Returns the (cardId, comment id if any)
 * pair for the UI to show a confirmation.
 */
export async function applyQuickAction(
  db: Db,
  input: { cardId: string; quickActionId: string; actorUserId: string },
  ctx: ActorCtx,
): Promise<{
  cardId: string
  commentId: string | null
  targetStageId: string
  targetBoardId: string
}> {
  const action = await db.boardQuickAction.findUnique({
    where: { id: input.quickActionId },
    include: {
      targetStage: { select: { id: true, name: true, boardId: true } },
    },
  })
  if (!action || action.archivedAt != null) {
    throw new BusinessError(
      'QUICK_ACTION_NOT_FOUND',
      'Quick action not found (or archived)',
      { quickActionId: input.quickActionId },
    )
  }
  if (!action.targetStage.boardId) {
    throw new BusinessError(
      'PIPELINE_STAGE_NOT_FOUND',
      'Target stage not bound to a board',
    )
  }

  // Comment first so it's timestamped just before the move (matches the
  // user's mental model: "called twice [then] → Called twice").
  let commentId: string | null = null
  if (action.commentTemplate && action.commentTemplate.trim().length > 0) {
    const comment = await addCardComment(
      db,
      {
        cardId: input.cardId,
        authorId: input.actorUserId,
        body: action.commentTemplate.trim(),
      },
      ctx,
    )
    commentId = comment.id
  }

  await moveCard(
    db,
    { cardId: input.cardId, toStageId: action.targetStageId },
    ctx,
  )

  return {
    cardId: input.cardId,
    commentId,
    targetStageId: action.targetStageId,
    targetBoardId: action.targetStage.boardId,
  }
}
