// Unit tests for the audit writer. The Prisma client is stubbed so tests run
// without a database — integration coverage lives under __tests__/integration/.

import { describe, expect, it, vi } from 'vitest'

import { writeAuditLogEntry } from './writer.js'

interface FakeRow {
  id: string
  action: string
  targetType: string
  targetId: string
  requestId: string | null
  actorId: string | null
}

function makeFakeDb() {
  const rows: FakeRow[] = []
  const findFirst = vi.fn(async (args: { where: Record<string, unknown> }) => {
    const where = args.where
    return (
      rows.find(
        (r) =>
          r.requestId === where.requestId &&
          r.action === where.action &&
          r.targetType === where.targetType &&
          r.targetId === where.targetId,
      ) ?? null
    )
  })
  const create = vi.fn(async (args: { data: FakeRow }) => {
    const row = { ...args.data }
    rows.push(row)
    return row
  })
  return {
    rows,
    findFirst,
    create,
    db: {
      auditLogEntry: { findFirst, create },
    } as unknown as Parameters<typeof writeAuditLogEntry>[0],
  }
}

describe('writeAuditLogEntry', () => {
  it('writes a single audit row and returns its id', async () => {
    const fake = makeFakeDb()
    const id = await writeAuditLogEntry(fake.db, {
      actorId: 'user_1',
      action: 'contact.created',
      target: { type: 'Contact', id: 'c_1' },
      after: { id: 'c_1' },
    })
    expect(id).toBeTypeOf('string')
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]?.action).toBe('contact.created')
  })

  it('is idempotent when the same (requestId, action, target) is replayed', async () => {
    const fake = makeFakeDb()
    const input = {
      actorId: 'user_1',
      action: 'contact.created',
      target: { type: 'Contact', id: 'c_1' },
      requestId: 'req_42',
      after: { id: 'c_1' },
    } as const

    const first = await writeAuditLogEntry(fake.db, input)
    const second = await writeAuditLogEntry(fake.db, input)

    expect(first).toEqual(second)
    expect(fake.create).toHaveBeenCalledTimes(1)
    expect(fake.rows).toHaveLength(1)
  })

  it('writes a separate row when requestId is absent (no idempotency)', async () => {
    const fake = makeFakeDb()
    await writeAuditLogEntry(fake.db, {
      actorId: null,
      action: 'contact.updated',
      target: { type: 'Contact', id: 'c_2' },
    })
    await writeAuditLogEntry(fake.db, {
      actorId: null,
      action: 'contact.updated',
      target: { type: 'Contact', id: 'c_2' },
    })
    expect(fake.create).toHaveBeenCalledTimes(2)
  })
})
