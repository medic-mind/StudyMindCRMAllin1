// Card sub-tasks (Todoist-style checklist on a board card). Lightweight,
// card-local checkboxes — distinct from the CRM Task table. Pure domain
// helpers; the tRPC layer owns RBAC. These are not individually audited
// (the card carries the audit trail); they're cheap, high-frequency
// toggles. CLAUDE.md §27.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { BusinessError } from '../errors'

type Db = PrismaClient | Prisma.TransactionClient

export interface CardSubtaskSummary {
  id: string
  cardId: string
  title: string
  completed: boolean
  position: number
}

function toSummary(row: {
  id: string
  cardId: string
  title: string
  completed: boolean
  position: number
}): CardSubtaskSummary {
  return {
    id: row.id,
    cardId: row.cardId,
    title: row.title,
    completed: row.completed,
    position: row.position,
  }
}

/** List a card's sub-tasks, ordered. */
export async function listCardSubtasks(
  db: Db,
  cardId: string,
): Promise<CardSubtaskSummary[]> {
  const rows = await db.cardSubtask.findMany({
    where: { cardId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.map(toSummary)
}

async function nextSubtaskPosition(db: Db, cardId: string): Promise<number> {
  const max = await db.cardSubtask.aggregate({
    where: { cardId },
    _max: { position: true },
  })
  return (max._max.position ?? 0) + 1
}

/** Add a sub-task to the end of a card's checklist. */
export async function addCardSubtask(
  db: Db,
  input: { cardId: string; title: string; actorId: string },
): Promise<CardSubtaskSummary> {
  const title = input.title.trim()
  if (title.length === 0) {
    throw new BusinessError('SUBTASK_EMPTY', 'A sub-task needs a title')
  }
  if (title.length > 280) {
    throw new BusinessError('SUBTASK_TOO_LONG', 'Sub-task title is too long')
  }
  const card = await db.card.findFirst({
    where: { id: input.cardId, archivedAt: null },
    select: { id: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  const position = await nextSubtaskPosition(db, input.cardId)
  const row = await db.cardSubtask.create({
    data: {
      id: createId(),
      cardId: input.cardId,
      title,
      position,
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })
  return toSummary(row)
}

/** Toggle / rename a sub-task. Only the fields provided are changed. */
export async function updateCardSubtask(
  db: Db,
  input: {
    id: string
    title?: string
    completed?: boolean
    actorId: string
  },
): Promise<CardSubtaskSummary> {
  const existing = await db.cardSubtask.findUnique({ where: { id: input.id } })
  if (!existing) throw new BusinessError('SUBTASK_NOT_FOUND', 'Sub-task not found')

  let title: string | undefined
  if (input.title !== undefined) {
    const trimmed = input.title.trim()
    if (trimmed.length === 0) {
      throw new BusinessError('SUBTASK_EMPTY', 'A sub-task needs a title')
    }
    if (trimmed.length > 280) {
      throw new BusinessError('SUBTASK_TOO_LONG', 'Sub-task title is too long')
    }
    title = trimmed
  }

  const row = await db.cardSubtask.update({
    where: { id: input.id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(input.completed !== undefined ? { completed: input.completed } : {}),
      updatedById: input.actorId,
    },
  })
  return toSummary(row)
}

/** Delete a sub-task. */
export async function deleteCardSubtask(db: Db, id: string): Promise<void> {
  const existing = await db.cardSubtask.findUnique({
    where: { id },
    select: { id: true },
  })
  if (!existing) throw new BusinessError('SUBTASK_NOT_FOUND', 'Sub-task not found')
  await db.cardSubtask.delete({ where: { id } })
}
