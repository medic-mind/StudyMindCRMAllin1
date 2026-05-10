// admin.flags router tests. Verifies role gating, env-source detection,
// and stale-release-flag flagging. CLAUDE.md §31.

import { describe, expect, it } from 'vitest'

import type { TrpcContext, SessionUser, AuditRecorder } from '@/lib/trpc/builders'

import { adminFlagsRouter } from './flags'

function makeAudit(): AuditRecorder {
  const fn = (async (_input: unknown) => {
    fn.called = true
    return 'a1'
  }) as unknown as AuditRecorder
  fn.called = false
  return fn
}

function makeCtx(role: SessionUser['role']) {
  const featureFlags: Array<{
    key: string
    enabled: boolean
    createdAt: Date
    updatedAt: Date
  }> = []

  const ctx: TrpcContext = {
    user: { id: 'u1', email: 'u@x.com', role },
    requestId: 'r1',
    db: {
      featureFlag: {
        findMany: () => Promise.resolve(featureFlags),
      },
    } as never,
    audit: makeAudit(),
    headers: { origin: null, host: null },
  }
  return { ctx, featureFlags }
}

describe('admin.flags.list', () => {
  it('rejects non admin/ops_manager', async () => {
    const { ctx } = makeCtx('agent')
    const c = adminFlagsRouter.createCaller(ctx)
    await expect(c.list()).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('returns one row per registered flag with default source', async () => {
    const { ctx } = makeCtx('admin')
    const c = adminFlagsRouter.createCaller(ctx)
    const r = await c.list()
    expect(r.items.length).toBeGreaterThan(0)
    for (const item of r.items) {
      expect(['env', 'db', 'default']).toContain(item.source)
    }
  })

  it('marks stale release flags older than 30 days', async () => {
    const { ctx, featureFlags } = makeCtx('admin')
    // Pick a release flag from registry — `ai.draft_replies_enabled` is
    // declared as a release flag.
    featureFlags.push({
      key: 'ai.draft_replies_enabled',
      enabled: true,
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 60),
      updatedAt: new Date(),
    })
    const c = adminFlagsRouter.createCaller(ctx)
    const r = await c.list()
    const stale = r.items.find((f) => f.name === 'ai.draft_replies_enabled')
    expect(stale?.stale).toBe(true)
    expect(stale?.source).toBe('db')
  })

  it('env override takes precedence over db', async () => {
    const { ctx, featureFlags } = makeCtx('ops_manager')
    featureFlags.push({
      key: 'finance.dunning_paused',
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    process.env.FLAG_FINANCE_DUNNING_PAUSED = 'true'
    try {
      const c = adminFlagsRouter.createCaller(ctx)
      const r = await c.list()
      const item = r.items.find((f) => f.name === 'finance.dunning_paused')
      expect(item?.source).toBe('env')
      expect(item?.effective).toBe(true)
    } finally {
      delete process.env.FLAG_FINANCE_DUNNING_PAUSED
    }
  })
})
