// Card comment thread + inline description (slice A). Comments and
// description changes persist as Interactions on the card's backing Contact
// so they show up in the customer's history ("everything saved to the
// customer entry"). Every write audits in the same call.
//
// Anyone authenticated may comment (the tRPC layer permits virtual_assistant);
// setting the description is gated to sales_executive+ at the tRPC layer.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

export interface CardComment {
  id: string
  cardId: string
  body: string
  authorId: string | null
  authorName: string | null
  occurredAt: Date
}

function userDisplayName(user: { name: string | null; email: string } | null): string | null {
  if (!user) return null
  const name = (user.name ?? '').trim()
  return name || user.email
}

async function resolveCardContact(db: Db, cardId: string): Promise<{ contactId: string }> {
  const card = await db.card.findFirst({
    where: { id: cardId, archivedAt: null },
    select: { id: true, contactId: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')
  return { contactId: card.contactId }
}

/**
 * Add a comment to a card. Resolves the card's backing contact and writes a
 * `card_comment` Interaction linked to that contact, then audits. Returns the
 * created comment (with the author's display name).
 */
export async function addCardComment(
  db: Db,
  input: { cardId: string; authorId: string; body: string },
  ctx: ActorCtx,
): Promise<CardComment> {
  const body = input.body.trim()
  if (body.length === 0) {
    throw new BusinessError('COMMENT_EMPTY', 'A comment cannot be empty')
  }
  const { contactId } = await resolveCardContact(db, input.cardId)

  const author = await db.user.findUnique({
    where: { id: input.authorId },
    select: { id: true, name: true, email: true },
  })

  const id = createId()
  const occurredAt = new Date()
  await db.interaction.create({
    data: {
      id,
      type: 'card_comment',
      contactId,
      occurredAt,
      summary: body.length > 120 ? `${body.slice(0, 117)}…` : body,
      payload: {
        event: 'card.commented',
        cardId: input.cardId,
        body,
        authorId: input.authorId,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.commented',
    target: { type: 'Card', id: input.cardId },
    before: null,
    after: { interactionId: id, contactId },
  })

  return {
    id,
    cardId: input.cardId,
    body,
    authorId: input.authorId,
    authorName: userDisplayName(author),
    occurredAt,
  }
}

/**
 * List the comments on a card, oldest first (the thread reads top-to-bottom).
 * Joins the author's display name from the createdById on each Interaction.
 */
export async function listCardComments(
  db: Db,
  input: { cardId: string },
): Promise<CardComment[]> {
  // Filter by cardId server-side on the JSONB path — scanning EVERY card_comment
  // across all boards and filtering in JS grew unbounded with total comment
  // volume on a hot path (opening any card modal).
  const forCard = await db.interaction.findMany({
    where: {
      type: 'card_comment',
      deletedAt: null,
      payload: { path: ['cardId'], equals: input.cardId },
    },
    orderBy: { occurredAt: 'asc' },
    select: {
      id: true,
      occurredAt: true,
      payload: true,
      contactId: true,
      createdById: true,
    },
  })

  const authorIds = [
    ...new Set(forCard.map((r) => r.createdById).filter((x): x is string => !!x)),
  ]
  const authors =
    authorIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, email: true },
        })
      : []
  const authorMap = new Map(authors.map((a) => [a.id, a] as const))

  return forCard.map((r) => {
    const payload = r.payload as { body?: unknown; authorId?: unknown }
    const author = r.createdById ? (authorMap.get(r.createdById) ?? null) : null
    return {
      id: r.id,
      cardId: input.cardId,
      body: typeof payload.body === 'string' ? payload.body : '',
      authorId: r.createdById ?? null,
      authorName: userDisplayName(author),
      occurredAt: r.occurredAt,
    }
  })
}

/**
 * Set (or clear) the card's description. Stores it on the Card row, writes a
 * `card_description_changed` Interaction on the backing Contact, and audits.
 */
export async function setCardDescription(
  db: Db,
  input: { cardId: string; description: string | null },
  ctx: ActorCtx,
): Promise<{ cardId: string; description: string | null }> {
  const card = await db.card.findFirst({
    where: { id: input.cardId, archivedAt: null },
    select: { id: true, contactId: true, description: true },
  })
  if (!card) throw new BusinessError('CARD_NOT_FOUND', 'Card not found')

  const next = input.description && input.description.trim().length > 0 ? input.description.trim() : null

  await db.card.update({
    where: { id: input.cardId },
    data: { description: next },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'card_description_changed',
      contactId: card.contactId,
      occurredAt: new Date(),
      summary: next ? 'Card description updated' : 'Card description cleared',
      payload: {
        event: 'card.description_changed',
        cardId: input.cardId,
        description: next,
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'card.description_changed',
    target: { type: 'Card', id: input.cardId },
    before: { description: card.description ?? null },
    after: { description: next },
  })

  return { cardId: input.cardId, description: next }
}
