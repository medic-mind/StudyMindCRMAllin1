// Customer at-risk triage router tests. CLAUDE.md §20 (role gating), §27
// (audited writes), §3 (flag/dismiss are explicit human decisions).

import { describe, expect, it } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext } from '@/lib/trpc/builders'

import { customerRiskRouter } from './customerRisk'

function makeAudit(): { audit: AuditRecorder; actions: string[] } {
  const actions: string[] = []
  const fn = (async (input: { action: string }) => {
    actions.push(input.action)
    fn.called = true
    return 'audit_id'
  }) as unknown as AuditRecorder
  fn.called = false
  return { audit: fn, actions }
}

type Row = Record<string, unknown>

interface FakeState {
  contacts: Row[]
  reviews: Row[]
  users: Row[]
}

function makeCtx(role: SessionUser['role'], seed: Partial<FakeState> = {}) {
  const s: FakeState = {
    contacts: seed.contacts ?? [],
    reviews: seed.reviews ?? [],
    users: seed.users ?? [],
  }
  const { audit, actions } = makeAudit()

  const db = {
    contact: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        s.contacts.find((c) => c.id === where.id) ?? null,
    },
    user: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        s.users.find((u) => u.id === where.id) ?? null,
    },
    contactRiskReview: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { contactId: string }
        create: Row
        update: Row
      }) => {
        const existing = s.reviews.find((r) => r.contactId === where.contactId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row = { ...create }
        s.reviews.push(row)
        return row
      },
      deleteMany: async ({ where }: { where: { contactId: string } }) => {
        const before = s.reviews.length
        s.reviews = s.reviews.filter((r) => r.contactId !== where.contactId)
        return { count: before - s.reviews.length }
      },
    },
  }

  const ctx: TrpcContext = {
    user: { id: 'u1', email: 'u@x.com', role },
    requestId: 'req1',
    db: db as never,
    audit,
    headers: { origin: null, host: null },
  }
  return { ctx, state: s, actions }
}

const SEED = {
  contacts: [{ id: 'c1' }],
  users: [{ id: 'u1', isActive: true, deletedAt: null }],
}

describe('customerRisk.setReview', () => {
  it('allows virtual_assistant (identical to sales_executive, 2026-07)', async () => {
    const { ctx, state, actions } = makeCtx('virtual_assistant', SEED)
    const caller = customerRiskRouter.createCaller(ctx)
    await caller.setReview({ contactId: 'c1', status: 'flagged' })
    expect(state.reviews).toHaveLength(1)
    expect(actions).toContain('contact.risk_flagged')
  })

  it('flags a customer and audits', async () => {
    const { ctx, state, actions } = makeCtx('sales_executive', SEED)
    const caller = customerRiskRouter.createCaller(ctx)
    await caller.setReview({ contactId: 'c1', status: 'flagged', note: 'chasing' })
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews[0]!.status).toBe('flagged')
    expect(actions).toContain('contact.risk_flagged')
  })

  it('dismiss then clear removes the row', async () => {
    const { ctx, state } = makeCtx('manager', SEED)
    const caller = customerRiskRouter.createCaller(ctx)
    await caller.setReview({ contactId: 'c1', status: 'dismissed' })
    expect(state.reviews).toHaveLength(1)
    await caller.clearReview({ contactId: 'c1' })
    expect(state.reviews).toHaveLength(0)
  })
})

