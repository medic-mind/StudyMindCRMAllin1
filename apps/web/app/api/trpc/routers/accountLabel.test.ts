// Account-label router tests. CLAUDE.md §20 (role gating), §27 (audited
// writes), §3 (idempotent label apply — re-applying is a no-op).
//
// Focus: the catalogue CRUD rejects the roles that must not call it, applying a
// label is idempotent on the composite PK, and detach/bulk paths audit per
// account. The fake db models just the tables these procedures touch.

import { describe, expect, it } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext } from '@/lib/trpc/builders'

import { accountLabelRouter } from './accountLabel'
import { businessAccountRouter } from './businessAccount'

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

interface Row {
  [k: string]: unknown
}

interface FakeState {
  labels: Row[]
  accounts: Row[]
  links: Row[] // BusinessAccountLabel rows: { accountId, labelId }
  contacts: Row[]
  contactLinks: Row[] // ContactLabel rows: { contactId, labelId }
}

function makeCtx(role: SessionUser['role'], seed: Partial<FakeState> = {}) {
  const s: FakeState = {
    labels: seed.labels ?? [],
    accounts: seed.accounts ?? [],
    links: seed.links ?? [],
    contacts: seed.contacts ?? [],
    contactLinks: seed.contactLinks ?? [],
  }
  const { audit, actions } = makeAudit()

  const db = {
    accountLabel: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        s.labels.find((l) => l.id === where.id) ?? null,
      findMany: async () => s.labels,
      create: async ({ data }: { data: Row }) => {
        s.labels.push({ archivedAt: null, ...data })
        return data
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const l = s.labels.find((x) => x.id === where.id)!
        Object.assign(l, data)
        return l
      },
    },
    businessAccount: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        s.accounts.find((a) => a.id === where.id) ?? null,
      findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) => {
        const ids = where?.id?.in
        return ids ? s.accounts.filter((a) => ids.includes(a.id as string)) : s.accounts
      },
    },
    businessAccountLabel: {
      upsert: async ({
        where,
        create,
      }: {
        where: { accountId_labelId: { accountId: string; labelId: string } }
        create: Row
      }) => {
        const key = where.accountId_labelId
        const existing = s.links.find(
          (l) => l.accountId === key.accountId && l.labelId === key.labelId,
        )
        if (existing) return existing // idempotent — no duplicate row
        s.links.push({ ...create })
        return create
      },
      deleteMany: async ({
        where,
      }: {
        where: { accountId: string; labelId: string }
      }) => {
        const before = s.links.length
        s.links = s.links.filter(
          (l) => !(l.accountId === where.accountId && l.labelId === where.labelId),
        )
        return { count: before - s.links.length }
      },
    },
    contact: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        s.contacts.find((c) => c.id === where.id) ?? null,
      findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) => {
        const ids = where?.id?.in
        return ids ? s.contacts.filter((c) => ids.includes(c.id as string)) : s.contacts
      },
    },
    contactLabel: {
      upsert: async ({
        where,
        create,
      }: {
        where: { contactId_labelId: { contactId: string; labelId: string } }
        create: Row
      }) => {
        const key = where.contactId_labelId
        const existing = s.contactLinks.find(
          (l) => l.contactId === key.contactId && l.labelId === key.labelId,
        )
        if (existing) return existing
        s.contactLinks.push({ ...create })
        return create
      },
      deleteMany: async ({
        where,
      }: {
        where: { contactId: string; labelId: string }
      }) => {
        const before = s.contactLinks.length
        s.contactLinks = s.contactLinks.filter(
          (l) => !(l.contactId === where.contactId && l.labelId === where.labelId),
        )
        return { count: before - s.contactLinks.length }
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

describe('accountLabel catalogue gating', () => {
  it('allows every staff role, incl. sales_executive + virtual_assistant (2026-07)', async () => {
    for (const role of ['sales_executive', 'virtual_assistant'] as const) {
      const { ctx, actions } = makeCtx(role)
      const caller = accountLabelRouter.createCaller(ctx)
      const res = await caller.create({ name: 'Priority', color: '#2563eb' })
      expect(res.id).toBeTruthy()
      expect(actions).toContain('account_label.created')
    }
  })

  it('allows manager to create and audits account_label.created', async () => {
    const { ctx, actions } = makeCtx('manager')
    const caller = accountLabelRouter.createCaller(ctx)
    const res = await caller.create({ name: 'Priority', color: '#2563eb' })
    expect(res.id).toBeTruthy()
    expect(actions).toContain('account_label.created')
  })
})

describe('accountLabel.attach', () => {
  function seed() {
    return {
      labels: [{ id: 'l1', name: 'Priority', archivedAt: null }],
      accounts: [{ id: 'a1' }],
      links: [] as Row[],
    }
  }

  it('allows virtual_assistant to apply labels (identical to sales_executive, 2026-07)', async () => {
    const { ctx, state } = makeCtx('virtual_assistant', seed())
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.attach({ accountId: 'a1', labelId: 'l1' })
    expect(state.links).toHaveLength(1)
  })

  it('is idempotent — applying twice yields one link row', async () => {
    const { ctx, state } = makeCtx('sales_executive', seed())
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.attach({ accountId: 'a1', labelId: 'l1' })
    await caller.attach({ accountId: 'a1', labelId: 'l1' })
    expect(state.links).toHaveLength(1)
  })

  it('detach removes the link and audits', async () => {
    const { ctx, state, actions } = makeCtx('sales_executive', {
      ...seed(),
      links: [{ accountId: 'a1', labelId: 'l1' }],
    })
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.detach({ accountId: 'a1', labelId: 'l1' })
    expect(state.links).toHaveLength(0)
    expect(actions).toContain('business_account.label_removed')
  })
})

describe('businessAccount.bulkSetLabel', () => {
  function seed() {
    return {
      labels: [{ id: 'l1', name: 'Priority', archivedAt: null }],
      accounts: [{ id: 'a1' }, { id: 'a2' }],
      links: [] as Row[],
    }
  }

  it('allows every staff role, incl. sales_executive + virtual_assistant (2026-07)', async () => {
    for (const role of ['sales_executive', 'virtual_assistant'] as const) {
      const { ctx, state } = makeCtx(role, seed())
      const caller = businessAccountRouter.createCaller(ctx)
      const res = await caller.bulkSetLabel({ ids: ['a1', 'a2'], labelId: 'l1' })
      expect(res.count).toBe(2)
      expect(state.links).toHaveLength(2)
    }
  })

  it('applies a label across many accounts and audits per account', async () => {
    const { ctx, state, actions } = makeCtx('manager', seed())
    const caller = businessAccountRouter.createCaller(ctx)
    const res = await caller.bulkSetLabel({ ids: ['a1', 'a2'], labelId: 'l1' })
    expect(res.count).toBe(2)
    expect(state.links).toHaveLength(2)
    expect(actions.filter((a) => a === 'business_account.label_added')).toHaveLength(2)
  })

  it('remove=true strips the label from each account', async () => {
    const { ctx, state } = makeCtx('manager', {
      ...seed(),
      links: [
        { accountId: 'a1', labelId: 'l1' },
        { accountId: 'a2', labelId: 'l1' },
      ],
    })
    const caller = businessAccountRouter.createCaller(ctx)
    await caller.bulkSetLabel({ ids: ['a1', 'a2'], labelId: 'l1', remove: true })
    expect(state.links).toHaveLength(0)
  })
})

describe('accountLabel customer (Contact) labelling', () => {
  function seed() {
    return {
      labels: [{ id: 'l1', name: 'Priority', archivedAt: null }],
      contacts: [{ id: 'c1' }, { id: 'c2' }],
      contactLinks: [] as Row[],
    }
  }

  it('attachContact allows virtual_assistant (identical to sales_executive, 2026-07)', async () => {
    const { ctx, state } = makeCtx('virtual_assistant', seed())
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.attachContact({ contactId: 'c1', labelId: 'l1' })
    expect(state.contactLinks).toHaveLength(1)
  })

  it('attachContact is idempotent', async () => {
    const { ctx, state } = makeCtx('sales_executive', seed())
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.attachContact({ contactId: 'c1', labelId: 'l1' })
    await caller.attachContact({ contactId: 'c1', labelId: 'l1' })
    expect(state.contactLinks).toHaveLength(1)
  })

  it('bulkSetContactLabel applies across customers and audits per contact', async () => {
    const { ctx, state, actions } = makeCtx('sales_executive', seed())
    const caller = accountLabelRouter.createCaller(ctx)
    const res = await caller.bulkSetContactLabel({ contactIds: ['c1', 'c2'], labelId: 'l1' })
    expect(res.count).toBe(2)
    expect(state.contactLinks).toHaveLength(2)
    expect(actions.filter((a) => a === 'contact.label_added')).toHaveLength(2)
  })

  it('bulkSetContactLabel remove=true strips the label', async () => {
    const { ctx, state } = makeCtx('manager', {
      ...seed(),
      contactLinks: [
        { contactId: 'c1', labelId: 'l1' },
        { contactId: 'c2', labelId: 'l1' },
      ],
    })
    const caller = accountLabelRouter.createCaller(ctx)
    await caller.bulkSetContactLabel({ contactIds: ['c1', 'c2'], labelId: 'l1', remove: true })
    expect(state.contactLinks).toHaveLength(0)
  })
})
