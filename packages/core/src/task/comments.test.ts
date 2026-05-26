// Task comment thread tests (slice B). Minimal in-memory fake DB.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { addTaskComment, listTaskComments } from './comments'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const tasks: Row[] = []
  const users: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string }> = []

  const db = {
    task: {
      findFirst: async ({ where }: { where: Row }) =>
        tasks.find((t) => t.id === where.id && t.deletedAt == null) ?? null,
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
      findMany: async ({ where }: { where: Row }) => {
        const ids = (where.id as { in: string[] }).in
        return users.filter((u) => ids.includes(u.id as string))
      },
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
      findMany: async ({ where }: { where: Row }) =>
        interactions.filter((i) => i.type === where.type && i.deletedAt == null),
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id: string; action: string } }) => {
        audits.push({ action: data.action })
        return { id: data.id }
      },
    },
  }

  return { db: db as never, tasks, users, interactions, audits }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

describe('addTaskComment', () => {
  it('links the interaction to the task contact when present', async () => {
    const t = makeDb()
    t.tasks.push({ id: 'task1', contactId: 'c1', deletedAt: null })
    t.users.push({ id: 'u1', name: 'Sam', email: 's@x.co' })
    const c = await addTaskComment(t.db, { taskId: 'task1', authorId: 'u1', body: 'follow up' }, ctx)
    expect(c.authorName).toBe('Sam')
    const written = t.interactions[0]!
    expect(written.type).toBe('task_comment')
    expect(written.contactId).toBe('c1')
    expect((written.payload as { taskId: string }).taskId).toBe('task1')
    expect(t.audits.some((a) => a.action === 'task.commented')).toBe(true)
  })

  it('stores a contactless interaction when the task has no contact', async () => {
    const t = makeDb()
    t.tasks.push({ id: 'task2', contactId: null, deletedAt: null })
    t.users.push({ id: 'u1', name: 'Sam', email: 's@x.co' })
    await addTaskComment(t.db, { taskId: 'task2', authorId: 'u1', body: 'internal' }, ctx)
    expect(t.interactions[0]!.contactId).toBeNull()
  })

  it('rejects a missing task and an empty body', async () => {
    const t = makeDb()
    t.tasks.push({ id: 'task1', contactId: null, deletedAt: null })
    await expect(
      addTaskComment(t.db, { taskId: 'nope', authorId: 'u1', body: 'x' }, ctx),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
    await expect(
      addTaskComment(t.db, { taskId: 'task1', authorId: 'u1', body: '  ' }, ctx),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('listTaskComments', () => {
  it('returns only this task comments, oldest first', async () => {
    const t = makeDb()
    t.tasks.push(
      { id: 'task1', contactId: null, deletedAt: null },
      { id: 'task2', contactId: null, deletedAt: null },
    )
    t.users.push({ id: 'u1', name: 'Sam', email: 's@x.co' })
    await addTaskComment(t.db, { taskId: 'task1', authorId: 'u1', body: 'a' }, ctx)
    await addTaskComment(t.db, { taskId: 'task2', authorId: 'u1', body: 'other' }, ctx)
    await addTaskComment(t.db, { taskId: 'task1', authorId: 'u1', body: 'b' }, ctx)
    const list = await listTaskComments(t.db, { taskId: 'task1' })
    expect(list.map((c) => c.body)).toEqual(['a', 'b'])
  })
})
