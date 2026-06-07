// Unit tests for the backfill core helpers. We stub the Prisma client with a
// minimal recording mock — these helpers contain no domain logic of their own
// beyond the idempotency check and the event-name shape, so the tests focus
// on those two contracts.

import { describe, expect, it, vi } from 'vitest'

import {
  BackfillAlreadyRunningError,
  incrementBackfillProgress,
  markBackfillCancelled,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
  reapStaleBackfills,
  startBackfill,
} from './index'

interface Recorded {
  backfillJobCreate: unknown[]
  backfillJobUpdate: unknown[]
  auditCreate: unknown[]
  sent: { name: string; data: Record<string, unknown> }[]
}

function makeStubs(existingJob: { id: string; updatedAt?: Date } | null = null) {
  const rec: Recorded = {
    backfillJobCreate: [],
    backfillJobUpdate: [],
    auditCreate: [],
    sent: [],
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    backfillJob: {
      findFirst: vi.fn(async () => existingJob),
      create: vi.fn(async (args: unknown) => {
        rec.backfillJobCreate.push(args)
        return { id: 'x' }
      }),
      update: vi.fn(async (args: unknown) => {
        rec.backfillJobUpdate.push(args)
        return { provider: 'gmail', agentId: 'u1' }
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLogEntry: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: unknown) => {
        rec.auditCreate.push(args)
        return { id: 'a' }
      }),
    },
  }
  const sender = {
    send: vi.fn(async (event: { name: string; data: Record<string, unknown> }) => {
      rec.sent.push(event)
      return {}
    }),
  }
  return { db, sender, rec }
}

describe('startBackfill', () => {
  it('creates a job, writes audit, sends the per-provider event', async () => {
    const { db, sender, rec } = makeStubs()
    const res = await startBackfill(db, sender, {
      provider: 'gmail',
      agentId: 'agent_1',
      ctx: { actorId: 'agent_1', requestId: 'req_1' },
    })
    expect(res.status).toBe('pending')
    expect(rec.backfillJobCreate).toHaveLength(1)
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0]?.name).toBe('backfill/gmail.requested')
    expect(rec.sent[0]?.data['provider']).toBe('gmail')
    expect(rec.auditCreate).toHaveLength(1)
  })

  it('throws when an active, recently-progressing job already exists', async () => {
    const { db, sender } = makeStubs({ id: 'existing', updatedAt: new Date() })
    await expect(
      startBackfill(db, sender, {
        provider: 'gmail',
        agentId: 'agent_1',
        ctx: { actorId: 'agent_1', requestId: 'req_2' },
      }),
    ).rejects.toBeInstanceOf(BackfillAlreadyRunningError)
  })

  it('supersedes a stalled job and starts a fresh one', async () => {
    // An orphaned run (no progress for >15 min) must not deadlock retries.
    const { db, sender, rec } = makeStubs({
      id: 'orphaned',
      updatedAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    const res = await startBackfill(db, sender, {
      provider: 'aircall',
      agentId: null,
      ctx: { actorId: 'agent_1', requestId: 'req_stale' },
    })
    expect(res.status).toBe('pending')
    // The stale row was marked failed (superseded) ...
    expect(rec.backfillJobUpdate).toHaveLength(1)
    // ... and a brand-new job + event were created.
    expect(rec.backfillJobCreate).toHaveLength(1)
    expect(rec.sent).toHaveLength(1)
    expect(rec.sent[0]?.name).toBe('backfill/aircall.requested')
  })

  it('honours a custom windowDays', async () => {
    const { db, sender, rec } = makeStubs()
    const windowTo = new Date('2026-05-24T00:00:00Z')
    await startBackfill(db, sender, {
      provider: 'aircall',
      agentId: null,
      windowDays: 30,
      windowTo,
      ctx: { actorId: null, requestId: 'req_3' },
    })
    const create = rec.backfillJobCreate[0] as { data: { windowFrom: Date; windowTo: Date } }
    const diffDays =
      (create.data.windowTo.getTime() - create.data.windowFrom.getTime()) /
      (24 * 60 * 60 * 1000)
    expect(diffDays).toBe(30)
  })
})

describe('progress helpers', () => {
  it('markBackfillRunning only transitions a pending row', async () => {
    const { db } = makeStubs()
    await markBackfillRunning(db, 'job_1')
    expect(db.backfillJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job_1', status: 'pending' },
      data: expect.objectContaining({ status: 'running' }),
    })
  })

  it('incrementBackfillProgress increments only the supplied counters', async () => {
    const { db } = makeStubs()
    await incrementBackfillProgress(db, 'job_1', { processed: 5, matched: 2 })
    const call = db.backfillJob.update.mock.calls[0][0] as {
      data: Record<string, unknown>
    }
    expect(call.data['processedCount']).toEqual({ increment: 5 })
    expect(call.data['matchedCount']).toEqual({ increment: 2 })
    expect(call.data['skippedCount']).toBeUndefined()
  })

  it('markBackfillCompleted writes a single summary audit', async () => {
    const { db, rec } = makeStubs()
    await markBackfillCompleted(db, 'job_1', {
      processed: 10,
      matched: 8,
      skipped: 2,
      requestId: 'req_done',
    })
    expect(rec.auditCreate).toHaveLength(1)
    const audit = rec.auditCreate[0] as { data: { action: string } }
    expect(audit.data.action).toBe('backfill.completed')
  })

  it('markBackfillFailed records a truncated error', async () => {
    const { db, rec } = makeStubs()
    await markBackfillFailed(db, 'job_1', 'x'.repeat(3000), 'req_fail')
    const audit = rec.auditCreate[0] as { data: { action: string; after: { error: string } } }
    expect(audit.data.action).toBe('backfill.failed')
    expect(audit.data.after.error.length).toBeLessThanOrEqual(500)
  })

  it('markBackfillCancelled audits the actor', async () => {
    const { db, rec } = makeStubs()
    await markBackfillCancelled(db, 'job_1', { actorId: 'u_admin', requestId: 'req_can' })
    const audit = rec.auditCreate[0] as { data: { action: string; actorId: string } }
    expect(audit.data.action).toBe('backfill.cancelled')
    expect(audit.data.actorId).toBe('u_admin')
  })
})

describe('reapStaleBackfills', () => {
  function makeReaperDb(staleRows: { id: string }[]) {
    const rec = { update: [] as unknown[], audit: [] as unknown[] }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      backfillJob: {
        findMany: vi.fn(async () => staleRows),
        update: vi.fn(async (args: unknown) => {
          rec.update.push(args)
          return { provider: 'aircall', agentId: null }
        }),
      },
      auditLogEntry: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: unknown) => {
          rec.audit.push(args)
          return { id: 'a' }
        }),
      },
    }
    return { db, rec }
  }

  it('fails every stale job and returns their ids', async () => {
    const { db, rec } = makeReaperDb([{ id: 'stale1' }, { id: 'stale2' }])
    const ids = await reapStaleBackfills(db, { now: new Date('2026-06-07T00:00:00Z') })
    expect(ids).toEqual(['stale1', 'stale2'])
    // Each reap marks the row failed (status update) + writes a failed audit.
    expect(rec.update).toHaveLength(2)
    expect(rec.audit).toHaveLength(2)
    expect((rec.audit[0] as { data: { action: string } }).data.action).toBe('backfill.failed')
  })

  it('queries only pending/running rows older than the stale window', async () => {
    const { db } = makeReaperDb([])
    const now = new Date('2026-06-07T12:00:00Z')
    await reapStaleBackfills(db, { now })
    const where = db.backfillJob.findMany.mock.calls[0][0].where
    expect(where.status).toEqual({ in: ['pending', 'running'] })
    expect(where.updatedAt.lt.getTime()).toBe(now.getTime() - 15 * 60 * 1000)
  })

  it('does nothing when no jobs are stale', async () => {
    const { db, rec } = makeReaperDb([])
    const ids = await reapStaleBackfills(db)
    expect(ids).toEqual([])
    expect(rec.update).toHaveLength(0)
  })
})
