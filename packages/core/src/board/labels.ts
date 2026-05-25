// Label domain (ADR 0018). Labels are coloured chips attached to cards.
// Create/update: Sales Executive and above. Delete: CEO + Senior Manager,
// and only when the label is unused.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

export interface LabelSummary {
  id: string
  name: string
  color: string
}

const labelSelect = { id: true, name: true, color: true } as const

export async function listLabels(db: Db): Promise<LabelSummary[]> {
  return db.label.findMany({
    orderBy: { name: 'asc' },
    select: labelSelect,
  })
}

export async function createLabel(
  db: Db,
  input: { name: string; color: string },
  ctx: ActorCtx,
): Promise<LabelSummary> {
  const dup = await db.label.findFirst({
    where: { name: { equals: input.name, mode: 'insensitive' } },
    select: { id: true },
  })
  if (dup) {
    throw new BusinessError('LABEL_NAME_TAKEN', 'A label with that name already exists')
  }
  const created = await db.label.create({
    data: { id: createId(), name: input.name, color: input.color },
    select: labelSelect,
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'label.created',
    target: { type: 'Label', id: created.id },
    before: null,
    after: created,
  })
  return created
}

export async function updateLabel(
  db: Db,
  input: { id: string; name?: string; color?: string },
  ctx: ActorCtx,
): Promise<LabelSummary> {
  const existing = await db.label.findUnique({
    where: { id: input.id },
    select: labelSelect,
  })
  if (!existing) throw new BusinessError('LABEL_NOT_FOUND', 'Label not found')

  if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
    const dup = await db.label.findFirst({
      where: { id: { not: input.id }, name: { equals: input.name, mode: 'insensitive' } },
      select: { id: true },
    })
    if (dup) {
      throw new BusinessError('LABEL_NAME_TAKEN', 'A label with that name already exists')
    }
  }

  const updated = await db.label.update({
    where: { id: input.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    },
    select: labelSelect,
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'label.updated',
    target: { type: 'Label', id: updated.id },
    before: existing,
    after: updated,
  })
  return updated
}

/** Delete a label only when no card references it. */
export async function deleteLabel(db: Db, id: string, ctx: ActorCtx): Promise<void> {
  const label = await db.label.findUnique({
    where: { id },
    select: labelSelect,
  })
  if (!label) throw new BusinessError('LABEL_NOT_FOUND', 'Label not found')
  const usage = await db.cardLabel.count({ where: { labelId: id } })
  if (usage > 0) {
    throw new BusinessError('LABEL_IN_USE', 'Cannot delete a label that is attached to cards', {
      usage,
    })
  }
  await db.label.delete({ where: { id } })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'label.deleted',
    target: { type: 'Label', id },
    before: label,
    after: null,
  })
}
