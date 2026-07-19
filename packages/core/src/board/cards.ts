// Card domain writers (ADR 0018). Card CRUD + move. Sales Executive and
// above (gated at tRPC). Every write audits in the same transaction.
//
// A card is backed by a Contact. When the caller supplies raw contact fields
// (rather than an existing contactId), the contact is created through the
// shared `ContactCreateInput` validation + `isMinorByDob` rule so we never
// duplicate contact validation logic.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import {
  ContactCreateInput,
  isMinorByDob,
  type ContactCreateInput as ContactCreate,
} from '../contact/types'
import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

export type CardContactArg = { contactId: string } | { contact: ContactCreate }

export interface CardSummary {
  id: string
  boardId: string
  stageId: string
  contactId: string
  subjectId: string | null
  position: number
}

const cardSelect = {
  id: true,
  boardId: true,
  stageId: true,
  contactId: true,
  subjectId: true,
  assigneeId: true,
  dueAt: true,
  scheduledCallAt: true,
  priority: true,
  position: true,
} as const

async function nextCardPosition(db: Db, boardId: string, stageId: string): Promise<number> {
  const max = await db.card.aggregate({
    where: { boardId, stageId, archivedAt: null },
    _max: { position: true },
  })
  return (max._max.position ?? 0) + 1
}

async function resolveStage(
  db: Db,
  boardId: string,
  stageId: string,
): Promise<{ id: string; name: string }> {
  const stage = await db.pipelineStage.findFirst({
    where: { id: stageId, boardId, archivedAt: null },
    select: { id: true, name: true },
  })
  if (!stage) {
    throw new BusinessError(
      'PIPELINE_STAGE_NOT_FOUND',
      'Stage not found on this board (or archived)',
      { boardId, stageId },
    )
  }
  return stage
}

/** Stage lookup with no board constraint — used for cross-board moves where
 * the target may be on a different board. Returns the `boardId` so the
 * caller can update `card.boardId` when the target is elsewhere. */
async function resolveStageAnyBoard(
  db: Db,
  stageId: string,
): Promise<{ id: string; name: string; boardId: string }> {
  const stage = await db.pipelineStage.findFirst({
    where: { id: stageId, archivedAt: null },
    select: { id: true, name: true, boardId: true },
  })
  if (!stage || !stage.boardId) {
    throw new BusinessError(
      'PIPELINE_STAGE_NOT_FOUND',
      'Stage not found (or archived)',
      { stageId },
    )
  }
  return { id: stage.id, name: stage.name, boardId: stage.boardId }
}

/**
 * Create a card on a board. If `contact` carries raw fields, a Contact is
 * created first via the shared validation path; otherwise an existing
 * Contact is linked by id. Writes `card.created` (and `contact.created`
 * when a new contact was made) audit rows in the same transaction.
 */
export async function createCard(
  db: Db,
  input: {
    boardId: string
    stageId: string
    contact: CardContactArg
    subjectId?: string
    labelIds?: ReadonlyArray<string>
    description?: string
    assigneeId?: string | null
    scheduledCallAt?: Date | null
  },
  ctx: ActorCtx,
): Promise<CardSummary> {
  const board = await db.board.findFirst({
    where: { id: input.boardId, archivedAt: null },
    select: { id: true },
  })
  if (!board) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found or archived')

  const stage = await resolveStage(db, input.boardId, input.stageId)

  if (input.assigneeId) {
    const user = await db.user.findFirst({
      where: { id: input.assigneeId, deletedAt: null, isActive: true },
      select: { id: true },
    })
    if (!user) {
      throw new BusinessError('CARD_NOT_FOUND', 'Assignee not found or inactive')
    }
  }

  if (input.subjectId) {
    const subject = await db.subject.findUnique({
      where: { id: input.subjectId },
      select: { id: true },
    })
    if (!subject) throw new BusinessError('SUBJECT_NOT_FOUND', 'Subject not found')
  }

  if (input.labelIds && input.labelIds.length > 0) {
    const found = await db.label.count({ where: { id: { in: [...input.labelIds] } } })
    if (found !== new Set(input.labelIds).size) {
      throw new BusinessError('LABEL_NOT_FOUND', 'One or more labels do not exist')
    }
  }

  // Resolve the backing contact.
  let contactId: string
  if ('contactId' in input.contact) {
    const contact = await db.contact.findFirst({
      where: { id: input.contact.contactId, deletedAt: null },
      select: { id: true },
    })
    if (!contact) throw new BusinessError('CONTACT_NOT_FOUND', 'Contact not found')
    contactId = contact.id
  } else {
    // Validate through the shared contact-create schema (single source of
    // truth) and apply the minor rule exactly as the contact router does.
    const parsed = ContactCreateInput.parse(input.contact.contact)
    const newContactId = createId()
    const createdContact = await db.contact.create({
      data: {
        id: newContactId,
        kind: parsed.kind,
        firstName: parsed.firstName ?? null,
        lastName: parsed.lastName ?? null,
        email: parsed.email ?? null,
        phoneE164: parsed.phoneE164 ?? null,
        dateOfBirth: parsed.dateOfBirth ?? null,
        isMinor: isMinorByDob(parsed.dateOfBirth),
        notes: parsed.notes ?? null,
        createdById: ctx.actorId,
        updatedById: ctx.actorId,
      },
      select: { id: true },
    })
    contactId = createdContact.id
    await writeAuditLogEntry(db, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      action: 'contact.created',
      target: { type: 'Contact', id: contactId },
      before: null,
      after: { id: contactId, kind: parsed.kind, viaCard: true },
    })
  }

  const position = await nextCardPosition(db, input.boardId, input.stageId)
  const card = await db.card.create({
    data: {
      id: createId(),
      boardId: input.boardId,
      stageId: input.stageId,
      contactId,
      subjectId: input.subjectId ?? null,
      description: input.description?.trim() ? input.description.trim() : null,
      assigneeId: input.assigneeId ?? null,
      scheduledCallAt: input.scheduledCallAt ?? null,
      position,
      createdById: ctx.actorId,
      ...(input.labelIds && input.labelIds.length > 0
        ? { labels: { create: input.labelIds.map((labelId) => ({ labelId })) } }
        : {}),
    },
    select: cardSelect,
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.created',
    target: { type: 'Card', id: card.id },
    before: null,
    after: { ...card, stageName: stage.name, labelIds: input.labelIds ?? [] },
  })
  return card
}

/**
 * Recompute contiguous `position` values for the active cards of a stage,
 * inserting `movedCardId` at `targetIndex` (0-based). Returns the list of
 * `{ id, position }` writes to persist. Positions are 1-based and contiguous
 * so drag reorders stay stable across moves. Pure — no I/O.
 */
function resequence(
  siblings: ReadonlyArray<{ id: string; position: number }>,
  movedCardId: string,
  targetIndex: number,
): Array<{ id: string; position: number }> {
  const others = siblings
    .filter((c) => c.id !== movedCardId)
    .sort((a, b) => a.position - b.position)
    .map((c) => c.id)
  const clamped = Math.max(0, Math.min(targetIndex, others.length))
  const ordered = [...others.slice(0, clamped), movedCardId, ...others.slice(clamped)]
  return ordered.map((id, i) => ({ id, position: i + 1 }))
}

/**
 * Move a card to a different stage (and optional position) on the same
 * board. Writes a `card_moved` Interaction on the backing Contact plus an
 * audit row, atomically. When `toPosition` is supplied the target stage's
 * cards are resequenced into contiguous positions so within-column drag
 * reorders persist; without it the card lands at the end of the stage.
 */
export async function moveCard(
  db: Db,
  input: { cardId: string; toStageId: string; toPosition?: number },
  ctx: ActorCtx,
): Promise<CardSummary> {
  const card = await db.card.findFirst({
    where: { id: input.cardId, archivedAt: null },
    select: { id: true, boardId: true, stageId: true, contactId: true, position: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  // Cross-board moves are supported when the target stage belongs to a
  // different board: we update card.boardId at the same time and place
  // the card at the end of the target stage on the target board.
  const toStageAny = await resolveStageAnyBoard(db, input.toStageId)
  const toStage = { id: toStageAny.id, name: toStageAny.name }
  const targetBoardId = toStageAny.boardId
  const isCrossBoard = targetBoardId !== card.boardId
  const fromStageId = card.stageId
  const fromBoardId = card.boardId

  // First place the card on the target stage (so it is part of the sibling
  // set), then resequence when an explicit position was requested.
  const landingPosition =
    input.toPosition ?? (await nextCardPosition(db, targetBoardId, input.toStageId))
  await db.card.update({
    where: { id: card.id },
    data: {
      stageId: input.toStageId,
      position: landingPosition,
      ...(isCrossBoard ? { boardId: targetBoardId } : {}),
    },
  })

  let position = landingPosition
  if (input.toPosition !== undefined) {
    const siblings = await db.card.findMany({
      where: { boardId: targetBoardId, stageId: input.toStageId, archivedAt: null },
      select: { id: true, position: true },
    })
    const writes = resequence(siblings, card.id, input.toPosition - 1)
    for (const w of writes) {
      await db.card.update({ where: { id: w.id }, data: { position: w.position } })
    }
    position = writes.find((w) => w.id === card.id)?.position ?? landingPosition
  }

  const updated = await db.card.findFirst({
    where: { id: card.id, archivedAt: null },
    select: cardSelect,
  })
  if (!updated) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'card_moved',
      contactId: card.contactId,
      occurredAt: new Date(),
      summary: `Card: → ${toStage.name}`,
      payload: {
        event: 'card.moved',
        cardId: card.id,
        boardId: targetBoardId,
        fromBoardId,
        fromStageId,
        toStageId: input.toStageId,
        ...(isCrossBoard ? { crossBoard: true } : {}),
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.moved',
    target: { type: 'Card', id: card.id },
    before: { boardId: fromBoardId, stageId: fromStageId, position: card.position },
    after: { boardId: targetBoardId, stageId: input.toStageId, position },
  })
  return updated
}

export async function updateCard(
  db: Db,
  input: {
    id: string
    subjectId?: string | null
    assigneeId?: string | null
    dueAt?: Date | null
    scheduledCallAt?: Date | null
    priority?: number | null
  },
  ctx: ActorCtx,
): Promise<CardSummary> {
  const existing = await db.card.findFirst({
    where: { id: input.id, archivedAt: null },
    select: cardSelect,
  })
  if (!existing) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  if (input.subjectId) {
    const subject = await db.subject.findUnique({
      where: { id: input.subjectId },
      select: { id: true },
    })
    if (!subject) throw new BusinessError('SUBJECT_NOT_FOUND', 'Subject not found')
  }
  if (input.assigneeId) {
    const user = await db.user.findFirst({
      where: { id: input.assigneeId, deletedAt: null, isActive: true },
      select: { id: true },
    })
    if (!user) {
      throw new BusinessError('CARD_NOT_FOUND', 'Assignee not found or inactive')
    }
  }

  const updated = await db.card.update({
    where: { id: input.id },
    data: {
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
      ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
      ...(input.scheduledCallAt !== undefined
        ? { scheduledCallAt: input.scheduledCallAt }
        : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
    select: cardSelect,
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.updated',
    target: { type: 'Card', id: updated.id },
    before: existing,
    after: updated,
  })
  return updated
}

export async function archiveCard(db: Db, id: string, ctx: ActorCtx): Promise<void> {
  const card = await db.card.findFirst({
    where: { id, archivedAt: null },
    select: cardSelect,
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')
  const now = new Date()
  await db.card.update({ where: { id }, data: { archivedAt: now } })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.archived',
    target: { type: 'Card', id },
    before: { archivedAt: null },
    after: { archivedAt: now.toISOString() },
  })
}

/**
 * Clear a whole board in one operation: soft-archive EVERY live card on it
 * (same reversible `archivedAt` mechanics as archiveCard, mirroring the
 * stage-archive precedent — board.stages.archive already bulk-archives a
 * stage's cards this way). Backing Contacts and their timeline history are
 * untouched. One audit row with the count — never per-card spam. The caller
 * must confirm with the user (§3).
 */
export async function clearBoardCards(
  db: Db,
  boardId: string,
  ctx: ActorCtx,
): Promise<{ archived: number }> {
  const board = await db.board.findFirst({
    where: { id: boardId, archivedAt: null },
    select: { id: true, name: true },
  })
  if (!board) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found')
  const now = new Date()
  const res = await db.card.updateMany({
    where: { boardId, archivedAt: null },
    data: { archivedAt: now },
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'board.cleared',
    target: { type: 'Board', id: boardId },
    after: { boardName: board.name, archivedCards: res.count, archivedAt: now.toISOString() },
  })
  return { archived: res.count }
}

/**
 * Permanently delete a card and its dependents (labels, subtasks). Distinct
 * from archive — this is irreversible. The backing Contact and any
 * Interactions written against it (card_moved, card_comment, etc) are
 * preserved; only the Card row itself and its scoped children go.
 *
 * CLAUDE.md §3 — no silent data mutation: every caller must confirm with the
 * user; §5 — every write audited.
 */
export async function deleteCard(db: Db, id: string, ctx: ActorCtx): Promise<void> {
  const card = await db.card.findUnique({
    where: { id },
    select: { ...cardSelect, archivedAt: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')
  // Cascade is configured on the FKs (CardLabel.cardId, CardSubtask.cardId)
  // so a single delete clears the children atomically.
  await db.card.delete({ where: { id } })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.deleted',
    target: { type: 'Card', id },
    before: card,
    after: null,
  })
}

export async function setCardLabels(
  db: Db,
  input: { cardId: string; labelIds: ReadonlyArray<string> },
  ctx: ActorCtx,
): Promise<void> {
  const card = await db.card.findFirst({
    where: { id: input.cardId, archivedAt: null },
    select: { id: true, labels: { select: { labelId: true } } },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  if (input.labelIds.length > 0) {
    const found = await db.label.count({ where: { id: { in: [...input.labelIds] } } })
    if (found !== new Set(input.labelIds).size) {
      throw new BusinessError('LABEL_NOT_FOUND', 'One or more labels do not exist')
    }
  }

  const before = card.labels.map((l) => l.labelId)
  await db.cardLabel.deleteMany({ where: { cardId: input.cardId } })
  if (input.labelIds.length > 0) {
    await db.cardLabel.createMany({
      data: input.labelIds.map((labelId) => ({ cardId: input.cardId, labelId })),
    })
  }
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.updated',
    target: { type: 'Card', id: input.cardId },
    before: { labelIds: before },
    after: { labelIds: [...input.labelIds] },
  })
}

export async function setCardSubject(
  db: Db,
  input: { cardId: string; subjectId: string | null },
  ctx: ActorCtx,
): Promise<CardSummary> {
  return updateCard(db, { id: input.cardId, subjectId: input.subjectId }, ctx)
}
