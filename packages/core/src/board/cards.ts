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
  },
  ctx: ActorCtx,
): Promise<CardSummary> {
  const board = await db.board.findFirst({
    where: { id: input.boardId, archivedAt: null },
    select: { id: true },
  })
  if (!board) throw new BusinessError('BOARD_NOT_FOUND', 'Board not found or archived')

  const stage = await resolveStage(db, input.boardId, input.stageId)

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
 * Move a card to a different stage (and optional position) on the same
 * board. Writes a `card_moved` Interaction on the backing Contact plus an
 * audit row, atomically.
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

  const toStage = await resolveStage(db, card.boardId, input.toStageId)
  const fromStageId = card.stageId
  const position = input.toPosition ?? (await nextCardPosition(db, card.boardId, input.toStageId))

  const updated = await db.card.update({
    where: { id: card.id },
    data: { stageId: input.toStageId, position },
    select: cardSelect,
  })

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
        boardId: card.boardId,
        fromStageId,
        toStageId: input.toStageId,
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
    before: { stageId: fromStageId, position: card.position },
    after: { stageId: input.toStageId, position },
  })
  return updated
}

export async function updateCard(
  db: Db,
  input: { id: string; subjectId?: string | null },
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

  const updated = await db.card.update({
    where: { id: input.id },
    data: {
      ...(input.subjectId !== undefined ? { subjectId: input.subjectId } : {}),
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
