// Communications Hub — mailAccount router tests (ADR 0021, Phase 1).
//
// In-memory `db` fake mirroring the pattern in account.test.ts. Covers the
// RBAC gates, the single-default transaction, shared-inbox membership, and the
// idempotent Gmail import. Invariant-heavy logic is property-tested in
// packages/core/src/mail/index.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AuditRecorder,
  SessionUser,
  TrpcContext,
  UserRole,
} from '@/lib/trpc/builders'

import { mailAccountRouter } from './mailAccount'

type Provider = 'gmail' | 'google_workspace' | 'outlook' | 'exchange' | 'imap'
type Status = 'connected' | 'needs_reconnect' | 'disconnected' | 'error'

interface AccountRow {
  id: string
  provider: Provider
  address: string
  displayName: string | null
  ownerKind: 'personal' | 'shared'
  ownerUserId: string | null
  teamId: string | null
  status: Status
  isDefault: boolean
  syncCursor: string | null
  watchExpiresAt: Date | null
  lastSyncedAt: Date | null
  gmailMailboxId: string | null
  createdAt: Date
  updatedAt: Date
  createdById: string | null
  updatedById: string | null
  deletedAt: Date | null
}

interface MemberRow {
  id: string
  mailAccountId: string
  userId: string
  access: string
  createdAt: Date
  createdById: string | null
}

interface GmailMailboxRow {
  id: string
  agentId: string
  address: string
  isDefault: boolean
  watchExpiresAt: Date | null
  deletedAt: Date | null
}

interface UserRow {
  id: string
  email: string
  name: string | null
  gmailConnectionStatus: string | null
}

function account(p: Partial<AccountRow> & Pick<AccountRow, 'id' | 'address'>): AccountRow {
  return {
    provider: 'gmail',
    displayName: null,
    ownerKind: 'personal',
    ownerUserId: null,
    teamId: null,
    status: 'connected',
    isDefault: false,
    syncCursor: null,
    watchExpiresAt: null,
    lastSyncedAt: null,
    gmailMailboxId: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: new Date('2026-05-01T00:00:00Z'),
    createdById: null,
    updatedById: null,
    deletedAt: null,
    ...p,
  }
}

type Where = Record<string, unknown>

function matchesWhere(row: Record<string, unknown>, where: Where): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const subs = value as Where[]
      if (!subs.some((s) => matchesWhere(row, s))) return false
      continue
    }
    if (key === 'deletedAt') {
      if (value === null && row['deletedAt'] != null) return false
      continue
    }
    if (key === 'id' && typeof value === 'object' && value !== null) {
      const inArr = (value as { in?: string[] }).in ?? []
      if (!inArr.includes(row['id'] as string)) return false
      continue
    }
    if (row[key] !== value) return false
  }
  return true
}

function makeCtx(opts: {
  role?: UserRole
  userId?: string
  accounts?: AccountRow[]
  members?: MemberRow[]
  gmailMailboxes?: GmailMailboxRow[]
  users?: UserRow[]
  gmailStatus?: string | null
}): {
  ctx: TrpcContext
  store: {
    accounts: AccountRow[]
    members: MemberRow[]
    gmailMailboxes: GmailMailboxRow[]
  }
  audit: ReturnType<typeof vi.fn>
} {
  const userId = opts.userId ?? 'u_me'
  const accounts = opts.accounts ?? []
  const members = opts.members ?? []
  const gmailMailboxes = opts.gmailMailboxes ?? []
  const users = opts.users ?? [
    { id: userId, email: 'me@studymind.co.uk', name: 'Me', gmailConnectionStatus: opts.gmailStatus ?? null },
  ]

  const audit = vi.fn(async (_input: unknown) => 'audit_1')
  const wrapped: AuditRecorder = (async (input) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const mailAccount = {
    findMany: ({ where, include }: { where: Where; include?: unknown }) => {
      const rows = accounts.filter((a) => matchesWhere(a as unknown as Where, where))
      return Promise.resolve(
        rows.map((r) =>
          include
            ? {
                ...r,
                team: null,
                _count: { members: members.filter((m) => m.mailAccountId === r.id).length },
              }
            : r,
        ),
      )
    },
    findFirst: ({ where }: { where: Where }) =>
      Promise.resolve(accounts.find((a) => matchesWhere(a as unknown as Where, where)) ?? null),
    findUnique: ({ where }: { where: Where }) => {
      const found = accounts.find((a) => {
        if ('address' in where) return a.address === where['address']
        if ('gmailMailboxId' in where) return a.gmailMailboxId === where['gmailMailboxId']
        if ('id' in where) return a.id === where['id']
        return false
      })
      return Promise.resolve(found ?? null)
    },
    create: ({ data }: { data: Partial<AccountRow> & { id: string; address: string } }) => {
      const row = account(data)
      accounts.push(row)
      return Promise.resolve(row)
    },
    update: ({ where, data }: { where: { id: string }; data: Partial<AccountRow> }) => {
      const row = accounts.find((a) => a.id === where.id)
      if (!row) throw new Error('not found')
      Object.assign(row, data, { updatedAt: new Date() })
      return Promise.resolve(row)
    },
    updateMany: ({ where, data }: { where: Where; data: Partial<AccountRow> }) => {
      let count = 0
      for (const row of accounts) {
        if (matchesWhere(row as unknown as Where, where)) {
          Object.assign(row, data)
          count++
        }
      }
      return Promise.resolve({ count })
    },
  }

  const mailAccountMember = {
    findMany: ({ where }: { where: Where }) =>
      Promise.resolve(members.filter((m) => matchesWhere(m as unknown as Where, where))),
    findUnique: ({ where }: { where: { mailAccountId_userId: { mailAccountId: string; userId: string } } }) => {
      const k = where.mailAccountId_userId
      return Promise.resolve(
        members.find((m) => m.mailAccountId === k.mailAccountId && m.userId === k.userId) ?? null,
      )
    },
    upsert: ({
      where,
      create,
      update,
    }: {
      where: { mailAccountId_userId: { mailAccountId: string; userId: string } }
      create: MemberRow
      update: Partial<MemberRow>
    }) => {
      const k = where.mailAccountId_userId
      const existing = members.find(
        (m) => m.mailAccountId === k.mailAccountId && m.userId === k.userId,
      )
      if (existing) {
        Object.assign(existing, update)
        return Promise.resolve(existing)
      }
      members.push({ ...create })
      return Promise.resolve(create)
    },
    delete: ({ where }: { where: { id: string } }) => {
      const idx = members.findIndex((m) => m.id === where.id)
      if (idx >= 0) members.splice(idx, 1)
      return Promise.resolve({ id: where.id })
    },
  }

  const gmailMailbox = {
    findMany: ({ where }: { where: Where }) =>
      Promise.resolve(gmailMailboxes.filter((g) => matchesWhere(g as unknown as Where, where))),
  }

  const user = {
    findUnique: ({ where }: { where: { id: string } }) =>
      Promise.resolve(users.find((u) => u.id === where.id) ?? null),
    findMany: ({ where }: { where: { id: { in: string[] } } }) =>
      Promise.resolve(users.filter((u) => where.id.in.includes(u.id))),
  }

  const db = {
    mailAccount,
    mailAccountMember,
    gmailMailbox,
    user,
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  }

  const sessionUser: SessionUser = {
    id: userId,
    email: 'me@studymind.co.uk',
    role: opts.role ?? 'sales_executive',
  }
  const ctx: TrpcContext = {
    user: sessionUser,
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, store: { accounts, members, gmailMailboxes }, audit }
}

beforeEach(() => vi.clearAllMocks())

describe('mailAccount.providers', () => {
  it('returns the capability registry', async () => {
    const { ctx } = makeCtx({})
    const providers = await mailAccountRouter.createCaller(ctx).providers()
    expect(providers.find((p) => p.id === 'gmail')?.connectable).toBe(true)
    expect(providers.find((p) => p.id === 'outlook')?.connectable).toBe(false)
  })
})

describe('mailAccount.list visibility', () => {
  const shared = account({
    id: 'a_shared',
    address: 'admissions@studymind.co.uk',
    ownerKind: 'shared',
    ownerUserId: 'u_other',
  })
  const myPersonal = account({
    id: 'a_mine',
    address: 'me@studymind.co.uk',
    ownerUserId: 'u_me',
  })
  const othersPersonal = account({
    id: 'a_other',
    address: 'other@studymind.co.uk',
    ownerUserId: 'u_other',
  })

  it('sales_executive sees own personal + shared they belong to, not others', async () => {
    const { ctx } = makeCtx({
      role: 'sales_executive',
      accounts: [shared, myPersonal, othersPersonal],
      members: [
        { id: 'mm_1', mailAccountId: 'a_shared', userId: 'u_me', access: 'agent', createdAt: new Date(), createdById: null },
      ],
    })
    const rows = await mailAccountRouter.createCaller(ctx).list()
    expect(rows.map((r) => r.id).sort()).toEqual(['a_mine', 'a_shared'])
  })

  it('manager sees every account', async () => {
    const { ctx } = makeCtx({
      role: 'manager',
      accounts: [shared, myPersonal, othersPersonal],
    })
    const rows = await mailAccountRouter.createCaller(ctx).list()
    expect(rows.map((r) => r.id).sort()).toEqual(['a_mine', 'a_other', 'a_shared'])
  })
})

describe('mailAccount.createShared', () => {
  it('manager creates a disconnected shared inbox and audits', async () => {
    const { ctx, store, audit } = makeCtx({ role: 'manager' })
    const r = await mailAccountRouter
      .createCaller(ctx)
      .createShared({ provider: 'gmail', address: 'Info@StudyMind.co.uk', displayName: 'Info' })
    const saved = store.accounts.find((a) => a.id === r.id)!
    expect(saved.ownerKind).toBe('shared')
    expect(saved.status).toBe('disconnected')
    expect(saved.address).toBe('info@studymind.co.uk') // normalised
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail_account.created' }),
    )
  })

  it('sales_executive is forbidden', async () => {
    const { ctx } = makeCtx({ role: 'sales_executive' })
    await expect(
      mailAccountRouter
        .createCaller(ctx)
        .createShared({ provider: 'gmail', address: 'sales@studymind.co.uk' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('conflicts on an existing active address', async () => {
    const { ctx } = makeCtx({
      role: 'manager',
      accounts: [account({ id: 'a_1', address: 'info@studymind.co.uk', ownerKind: 'shared' })],
    })
    await expect(
      mailAccountRouter
        .createCaller(ctx)
        .createShared({ provider: 'gmail', address: 'info@studymind.co.uk' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('mailAccount.setDefault', () => {
  it('clears the previous default (single-default invariant)', async () => {
    const { ctx, store } = makeCtx({
      role: 'sales_executive',
      userId: 'u_me',
      accounts: [
        account({ id: 'a_1', address: 'one@studymind.co.uk', ownerUserId: 'u_me', isDefault: true }),
        account({ id: 'a_2', address: 'two@studymind.co.uk', ownerUserId: 'u_me', isDefault: false }),
      ],
    })
    await mailAccountRouter.createCaller(ctx).setDefault({ id: 'a_2' })
    expect(store.accounts.find((a) => a.id === 'a_1')!.isDefault).toBe(false)
    expect(store.accounts.find((a) => a.id === 'a_2')!.isDefault).toBe(true)
  })

  it("rejects making someone else's / a shared mailbox the default", async () => {
    const { ctx } = makeCtx({
      role: 'sales_executive',
      userId: 'u_me',
      accounts: [account({ id: 'a_s', address: 'shared@studymind.co.uk', ownerKind: 'shared', ownerUserId: 'u_other' })],
    })
    await expect(
      mailAccountRouter.createCaller(ctx).setDefault({ id: 'a_s' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})

describe('mailAccount.members.add', () => {
  const shared = account({ id: 'a_s', address: 'ops@studymind.co.uk', ownerKind: 'shared', ownerUserId: 'u_me' })

  it('manager adds a member to a shared inbox', async () => {
    const { ctx, store, audit } = makeCtx({ role: 'manager', accounts: [shared] })
    await mailAccountRouter
      .createCaller(ctx)
      .members.add({ mailAccountId: 'a_s', userId: 'u_x', access: 'agent' })
    expect(store.members.some((m) => m.userId === 'u_x')).toBe(true)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail_account.member_added' }),
    )
  })

  it('rejects adding a member to a personal account', async () => {
    const personal = account({ id: 'a_p', address: 'p@studymind.co.uk', ownerKind: 'personal', ownerUserId: 'u_me' })
    const { ctx } = makeCtx({ role: 'manager', accounts: [personal] })
    await expect(
      mailAccountRouter.createCaller(ctx).members.add({ mailAccountId: 'a_p', userId: 'u_x' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('sales_executive cannot manage membership', async () => {
    const { ctx } = makeCtx({ role: 'sales_executive', accounts: [shared] })
    await expect(
      mailAccountRouter.createCaller(ctx).members.add({ mailAccountId: 'a_s', userId: 'u_x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('mailAccount.syncFromGmail', () => {
  it('imports connected Gmail mailboxes idempotently', async () => {
    const gmailMailboxes: GmailMailboxRow[] = [
      { id: 'gm_1', agentId: 'u_me', address: 'me@studymind.co.uk', isDefault: true, watchExpiresAt: null, deletedAt: null },
      { id: 'gm_2', agentId: 'u_me', address: 'me.alt@studymind.co.uk', isDefault: false, watchExpiresAt: null, deletedAt: null },
    ]
    const { ctx, store, audit } = makeCtx({
      role: 'sales_executive',
      userId: 'u_me',
      gmailMailboxes,
      gmailStatus: 'connected',
    })
    const r1 = await mailAccountRouter.createCaller(ctx).syncFromGmail()
    expect(r1.imported).toBe(2)
    expect(store.accounts).toHaveLength(2)
    expect(store.accounts.every((a) => a.provider === 'gmail' && a.ownerKind === 'personal')).toBe(true)
    expect(store.accounts.find((a) => a.gmailMailboxId === 'gm_1')!.status).toBe('connected')

    // Idempotent: a second run does not duplicate.
    const r2 = await mailAccountRouter.createCaller(ctx).syncFromGmail()
    expect(r2.imported).toBe(2)
    expect(store.accounts).toHaveLength(2)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'mail_account.imported' }),
    )
  })
})
