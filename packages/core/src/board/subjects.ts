// Subject domain (ADR 0018). Subjects are created dynamically via
// pick-existing-or-create; the picker orders by lastUsedAt desc.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import type { ActorCtx, Db } from './ctx'

export interface SubjectSummary {
  id: string
  name: string
  lastUsedAt: Date | null
}

/**
 * Case-insensitive find-or-create. On a hit, bumps `lastUsedAt` so the
 * subject floats to the top of the picker. On a miss, creates the subject
 * and audits `subject.created`.
 */
export async function findOrCreateSubject(
  db: Db,
  input: { name: string },
  ctx: ActorCtx,
): Promise<SubjectSummary> {
  const name = input.name.trim()
  const now = new Date()
  const existing = await db.subject.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
    select: { id: true, name: true, lastUsedAt: true },
  })
  if (existing) {
    const bumped = await db.subject.update({
      where: { id: existing.id },
      data: { lastUsedAt: now },
      select: { id: true, name: true, lastUsedAt: true },
    })
    return bumped
  }
  const created = await db.subject.create({
    data: {
      id: createId(),
      name,
      lastUsedAt: now,
      createdById: ctx.actorId,
    },
    select: { id: true, name: true, lastUsedAt: true },
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'subject.created',
    target: { type: 'Subject', id: created.id },
    before: null,
    after: created,
  })
  return created
}

/** Subjects ordered for the picker: most-recently-used first. */
export async function listSubjects(db: Db, input: { q?: string } = {}): Promise<SubjectSummary[]> {
  return db.subject.findMany({
    where: input.q ? { name: { contains: input.q, mode: 'insensitive' } } : undefined,
    orderBy: [{ lastUsedAt: 'desc' }, { name: 'asc' }],
    take: 50,
    select: { id: true, name: true, lastUsedAt: true },
  })
}
