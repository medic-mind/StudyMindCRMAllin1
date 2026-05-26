// Task comment thread (slice B). Comments persist as `task_comment`
// Interactions. When the task is linked to a Contact, the Interaction is
// linked to that contact so it appears in the customer's history; otherwise
// the Interaction has no contact and the payload carries the taskId. Every
// write audits.
//
// Anyone authenticated may comment (gated at the tRPC layer); the same
// CommentThread UI from slice A is reused.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'

export interface TaskComment {
  id: string
  taskId: string
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

/**
 * Add a comment to a task. Resolves the task's contactId (if any) and writes a
 * `task_comment` Interaction — linked to that contact when present so it lands
 * in the customer history, otherwise linked only to the task via the payload.
 */
export async function addTaskComment(
  db: Db,
  input: { taskId: string; authorId: string; body: string },
  ctx: ActorCtx,
): Promise<TaskComment> {
  const body = input.body.trim()
  if (body.length === 0) {
    throw new BusinessError('COMMENT_EMPTY', 'A comment cannot be empty')
  }
  const task = await db.task.findFirst({
    where: { id: input.taskId, deletedAt: null },
    select: { id: true, contactId: true },
  })
  if (!task) throw new BusinessError('TASK_NOT_FOUND', 'Task not found')

  const author = await db.user.findUnique({
    where: { id: input.authorId },
    select: { id: true, name: true, email: true },
  })

  const id = createId()
  const occurredAt = new Date()
  await db.interaction.create({
    data: {
      id,
      type: 'task_comment',
      contactId: task.contactId ?? null,
      occurredAt,
      summary: body.length > 120 ? `${body.slice(0, 117)}…` : body,
      payload: {
        event: 'task.commented',
        taskId: input.taskId,
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
    action: 'task.commented',
    target: { type: 'Task', id: input.taskId },
    before: null,
    after: { interactionId: id, contactId: task.contactId ?? null },
  })

  return {
    id,
    taskId: input.taskId,
    body,
    authorId: input.authorId,
    authorName: userDisplayName(author),
    occurredAt,
  }
}

/** List a task's comments, oldest first, with author display names. */
export async function listTaskComments(
  db: Db,
  input: { taskId: string },
): Promise<TaskComment[]> {
  const rows = await db.interaction.findMany({
    where: { type: 'task_comment', deletedAt: null },
    orderBy: { occurredAt: 'asc' },
    select: { id: true, occurredAt: true, payload: true, createdById: true },
  })
  const forTask = rows.filter((r) => {
    const payload = r.payload as { taskId?: unknown } | null
    return payload != null && payload.taskId === input.taskId
  })

  const authorIds = [
    ...new Set(forTask.map((r) => r.createdById).filter((x): x is string => !!x)),
  ]
  const authors =
    authorIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, email: true },
        })
      : []
  const authorMap = new Map(authors.map((a) => [a.id, a] as const))

  return forTask.map((r) => {
    const payload = r.payload as { body?: unknown }
    const author = r.createdById ? (authorMap.get(r.createdById) ?? null) : null
    return {
      id: r.id,
      taskId: input.taskId,
      body: typeof payload.body === 'string' ? payload.body : '',
      authorId: r.createdById ?? null,
      authorName: userDisplayName(author),
      occurredAt: r.occurredAt,
    }
  })
}
