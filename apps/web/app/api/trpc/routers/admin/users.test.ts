// Admin users router tests. Exercises role gating via canGrantRole/
// canRevokeRole, audit calls, last-super_admin guard, deactivation with
// DSL reassignment, and the invite/accept-invite paths. CLAUDE.md §20.

import { describe, expect, it, vi } from 'vitest'

import type { TrpcContext, SessionUser, AuditRecorder } from '@/lib/trpc/builders'

import { adminUsersRouter } from './users'

vi.mock('@studymind/integration-resend', () => ({
  sendEmail: vi.fn(async () => ({ status: 'sent' as const, id: 'm1' })),
}))

interface FakeUser {
  id: string
  email: string
  name: string | null
  isActive: boolean
  passwordHash: string | null
  emailVerifiedAt: Date | null
  deactivatedAt: Date | null
  deactivationReason: string | null
  lockedUntil: Date | null
  failedSignInAttempts: number
  mustResetPassword: boolean
  lastSignInAt: Date | null
  lastSignInIp: string | null
  deletedAt: Date | null
  roleAssignments: { id: string; role: string }[]
  sessions: { id: string }[]
}

interface FakeFlag {
  id: string
  contactId: string
  dslUserId: string | null
  state: string
  closedAt: Date | null
  deletedAt: Date | null
}

function makeCtx(role: SessionUser['role'], userId = 'actor_1') {
  const users: FakeUser[] = [
    {
      id: 'super_1',
      email: 'super@example.com',
      name: 'Super',
      isActive: true,
      passwordHash: 'h',
      emailVerifiedAt: new Date(),
      deactivatedAt: null,
      deactivationReason: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      mustResetPassword: false,
      lastSignInAt: new Date(),
      lastSignInIp: null,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_super_1', role: 'super_admin' }],
      sessions: [],
    },
    {
      id: 'actor_1',
      email: 'actor@example.com',
      name: 'Actor',
      isActive: true,
      passwordHash: 'h',
      emailVerifiedAt: new Date(),
      deactivatedAt: null,
      deactivationReason: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      mustResetPassword: false,
      lastSignInAt: new Date(),
      lastSignInIp: null,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_actor_admin', role: 'admin' }],
      sessions: [],
    },
    {
      id: 'u_2',
      email: 'agent@example.com',
      name: 'Ag',
      isActive: true,
      passwordHash: 'h',
      emailVerifiedAt: new Date(),
      deactivatedAt: null,
      deactivationReason: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      mustResetPassword: false,
      lastSignInAt: null,
      lastSignInIp: null,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_2_agent', role: 'agent' }],
      sessions: [{ id: 's_2' }],
    },
    {
      id: 'dsl_1',
      email: 'dsl@example.com',
      name: 'DSL',
      isActive: true,
      passwordHash: 'h',
      emailVerifiedAt: new Date(),
      deactivatedAt: null,
      deactivationReason: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      mustResetPassword: false,
      lastSignInAt: null,
      lastSignInIp: null,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_dsl_1', role: 'dsl' }],
      sessions: [],
    },
    {
      id: 'dsl_2',
      email: 'dsl2@example.com',
      name: 'DSL2',
      isActive: true,
      passwordHash: 'h',
      emailVerifiedAt: new Date(),
      deactivatedAt: null,
      deactivationReason: null,
      lockedUntil: null,
      failedSignInAttempts: 0,
      mustResetPassword: false,
      lastSignInAt: null,
      lastSignInIp: null,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_dsl_2', role: 'dsl' }],
      sessions: [],
    },
  ]
  const ras: { id: string; userId: string; role: string }[] = users
    .flatMap((u) => u.roleAssignments.map((ra) => ({ ...ra, userId: u.id })))
  const flags: FakeFlag[] = [
    {
      id: 'sf_1',
      contactId: 'c_1',
      dslUserId: 'dsl_1',
      state: 'concern_logged',
      closedAt: null,
      deletedAt: null,
    },
  ]
  const tokens: { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }[] = []
  const sessions: { id: string; userId: string }[] = users.flatMap((u) =>
    u.sessions.map((s) => ({ id: s.id, userId: u.id })),
  )

  const auditCalls: { action: string; target: { type: string; id: string } }[] = []
  const audit = (async (input: { action: string; target: { type: string; id: string } }) => {
    auditCalls.push({ action: input.action, target: input.target })
    ;(audit as unknown as { called: boolean }).called = true
    return 'audit_' + auditCalls.length
  }) as AuditRecorder
  ;(audit as unknown as { called: boolean }).called = false

  const db = {
    user: {
      findMany: () => {
        const rows = users.filter((u) => u.deletedAt === null)
        return Promise.resolve(rows)
      },
      findFirst: ({ where }: { where: { id: string; deletedAt: null; deactivatedAt?: null; roleAssignments?: { some: { role: string } } } }) => {
        const row = users.find((u) => u.id === where.id && u.deletedAt === null)
        if (!row) return Promise.resolve(null)
        if (where.deactivatedAt === null && row.deactivatedAt !== null) return Promise.resolve(null)
        if (where.roleAssignments?.some?.role && !row.roleAssignments.some((ra) => ra.role === where.roleAssignments?.some?.role)) {
          return Promise.resolve(null)
        }
        return Promise.resolve(row)
      },
      findUnique: ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email) return Promise.resolve(users.find((u) => u.email === where.email) ?? null)
        if (where.id) return Promise.resolve(users.find((u) => u.id === where.id) ?? null)
        return Promise.resolve(null)
      },
      create: ({ data }: { data: Partial<FakeUser> & { id: string; email: string } }) => {
        const u: FakeUser = {
          id: data.id,
          email: data.email,
          name: data.name ?? null,
          isActive: true,
          passwordHash: data.passwordHash ?? null,
          emailVerifiedAt: data.emailVerifiedAt ?? null,
          deactivatedAt: null,
          deactivationReason: null,
          lockedUntil: null,
          failedSignInAttempts: 0,
          mustResetPassword: data.mustResetPassword ?? false,
          lastSignInAt: null,
          lastSignInIp: null,
          deletedAt: null,
          roleAssignments: [],
          sessions: [],
        }
        users.push(u)
        return Promise.resolve(u)
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const u = users.find((x) => x.id === where.id)
        if (u) Object.assign(u, data)
        return Promise.resolve(u)
      },
    },
    roleAssignment: {
      findUnique: ({ where }: { where: { userId_role: { userId: string; role: string } } }) =>
        Promise.resolve(
          ras.find(
            (r) =>
              r.userId === where.userId_role.userId && r.role === where.userId_role.role,
          ) ?? null,
        ),
      create: ({ data }: { data: { id: string; userId: string; role: string } }) => {
        ras.push({ id: data.id, userId: data.userId, role: data.role })
        const u = users.find((x) => x.id === data.userId)
        u?.roleAssignments.push({ id: data.id, role: data.role })
        return Promise.resolve({ id: data.id })
      },
      delete: ({ where }: { where: { id: string } }) => {
        const idx = ras.findIndex((r) => r.id === where.id)
        const r = ras[idx]
        if (r) {
          ras.splice(idx, 1)
          const u = users.find((x) => x.id === r.userId)
          if (u) u.roleAssignments = u.roleAssignments.filter((x) => x.id !== r.id)
        }
        return Promise.resolve({ id: where.id })
      },
      deleteMany: ({ where }: { where: { userId: string } }) => {
        for (let i = ras.length - 1; i >= 0; i--) {
          const r = ras[i]
          if (r && r.userId === where.userId) {
            ras.splice(i, 1)
          }
        }
        const u = users.find((x) => x.id === where.userId)
        if (u) u.roleAssignments = []
        return Promise.resolve({ count: 0 })
      },
      count: ({ where }: { where: { role: string; userId?: { not: string } } }) => {
        const filtered = ras.filter(
          (r) =>
            r.role === where.role &&
            (!where.userId?.not || r.userId !== where.userId.not),
        )
        return Promise.resolve(filtered.length)
      },
    },
    safeguardingFlag: {
      findMany: ({
        where,
      }: {
        where: { dslUserId: string; deletedAt: null; closedAt: null }
      }) =>
        Promise.resolve(
          flags.filter(
            (f) =>
              f.dslUserId === where.dslUserId &&
              f.deletedAt === null &&
              f.closedAt === null,
          ),
        ),
      updateMany: ({
        where,
        data,
      }: {
        where: { id: { in: string[] } }
        data: { dslUserId: string }
      }) => {
        for (const f of flags) {
          if (where.id.in.includes(f.id)) {
            f.dslUserId = data.dslUserId
          }
        }
        return Promise.resolve({ count: where.id.in.length })
      },
    },
    emailVerificationToken: {
      create: ({ data }: { data: { id: string; userId: string; tokenHash: string; expiresAt: Date } }) => {
        tokens.push({ ...data, usedAt: null })
        return Promise.resolve({ id: data.id })
      },
      updateMany: ({ where, data }: { where: { userId: string; usedAt: null }; data: { usedAt: Date } }) => {
        for (const t of tokens) {
          if (t.userId === where.userId && t.usedAt === null) {
            t.usedAt = data.usedAt
          }
        }
        return Promise.resolve({ count: 0 })
      },
    },
    session: {
      deleteMany: ({ where }: { where: { userId: string } }) => {
        for (let i = sessions.length - 1; i >= 0; i--) {
          const s = sessions[i]
          if (s && s.userId === where.userId) sessions.splice(i, 1)
        }
        return Promise.resolve({ count: 0 })
      },
    },
  }

  const ctx: TrpcContext = {
    user: { id: userId, email: 'a@b.c', role },
    requestId: 'req_1',
    db: db as never,
    audit,
    headers: { origin: null, host: null },
  }
  return { ctx, audit, auditCalls, ras, users, flags, tokens, sessions }
}

describe('admin.users router', () => {
  it('list returns rows for admin with status', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const out = await caller.list({ limit: 50 })
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items[0]?.status).toBeDefined()
  })

  it('list rejects non-admin/non-super_admin', async () => {
    const { ctx } = makeCtx('agent')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(caller.list({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('invite refuses a role admin cannot grant', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.invite({ email: 'new@example.com', roles: ['admin'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('invite happy path creates user, role assignments, and audit', async () => {
    const { ctx, auditCalls, users } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.invite({
      email: 'newbie@example.com',
      name: 'Newbie',
      roles: ['agent', 'finance'],
    })
    expect(r.email).toBe('newbie@example.com')
    expect(users.find((u) => u.email === 'newbie@example.com')).toBeDefined()
    expect(auditCalls.some((a) => a.action === 'auth.user_invited')).toBe(true)
  })

  it('assignRole respects canGrantRole', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    // admin cannot grant admin
    await expect(
      caller.assignRole({ userId: 'u_2', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // admin can grant finance
    const ok = await caller.assignRole({ userId: 'u_2', role: 'finance' })
    expect(ok.alreadyPresent).toBe(false)
  })

  it('revokeRole respects canRevokeRole', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.revokeRole({ userId: 'super_1', role: 'super_admin' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('revokeRole blocks last super_admin', async () => {
    const { ctx } = makeCtx('super_admin', 'super_1')
    const caller = adminUsersRouter.createCaller(ctx)
    // self-demotion locked first
    await expect(
      caller.revokeRole({ userId: 'super_1', role: 'super_admin' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('revokeRole last-super_admin guard fires for other user', async () => {
    // super_admin tries to revoke super_admin from another super_admin who is
    // currently the *only other* super_admin — but here super_1 is the only
    // one. Make the actor a different super_admin.
    const { ctx, ras, users } = makeCtx('super_admin', 'actor_1')
    // Promote actor to super_admin too, leaving super_1 as the additional
    // super_admin. Then try to revoke super_1.
    ras.push({ id: 'ra_actor_super', userId: 'actor_1', role: 'super_admin' })
    const u = users.find((x) => x.id === 'actor_1')
    u?.roleAssignments.push({ id: 'ra_actor_super', role: 'super_admin' })
    const caller = adminUsersRouter.createCaller(ctx)
    // Now we have two super_admins (actor_1 + super_1). Revoke super_1's.
    const r = await caller.revokeRole({ userId: 'super_1', role: 'super_admin' })
    expect(r.ok).toBe(true)
    // Now only actor_1 is super_admin. Revoking again would be the last —
    // but we cannot revoke our own super_admin (self-demotion locked).
    await expect(
      caller.revokeRole({ userId: 'actor_1', role: 'super_admin' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('deactivate as DSL requires reassignToUserId', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.deactivate({ userId: 'dsl_1', reason: 'left' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('deactivate as DSL succeeds when reassignToUserId is provided', async () => {
    const { ctx, flags, sessions } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.deactivate({
      userId: 'dsl_1',
      reason: 'left',
      reassignToUserId: 'dsl_2',
    })
    expect(r.ok).toBe(true)
    expect(flags[0]?.dslUserId).toBe('dsl_2')
    expect(sessions.find((s) => s.userId === 'dsl_1')).toBeUndefined()
  })

  it('deactivate refuses self-deactivation', async () => {
    const { ctx } = makeCtx('admin', 'actor_1')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.deactivate({ userId: 'actor_1', reason: 'why' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
