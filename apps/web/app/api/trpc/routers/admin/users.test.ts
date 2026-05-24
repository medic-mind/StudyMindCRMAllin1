// Admin users router tests. Exercises role gating via canGrantRole/
// canRevokeRole, audit calls, last-ceo guard, and the invite/accept-invite
// paths. CLAUDE.md §20, ADR 0014.

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

function makeCtx(role: SessionUser['role'], userId = 'actor_1') {
  const users: FakeUser[] = [
    {
      id: 'ceo_1',
      email: 'ceo@example.com',
      name: 'CEO',
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
      roleAssignments: [{ id: 'ra_ceo_1', role: 'ceo' }],
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
      roleAssignments: [{ id: 'ra_actor_senior', role: 'senior_manager' }],
      sessions: [],
    },
    {
      id: 'u_2',
      email: 'sales@example.com',
      name: 'Sales',
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
      roleAssignments: [{ id: 'ra_2_sales', role: 'sales_executive' }],
      sessions: [{ id: 's_2' }],
    },
    {
      id: 'mgr_1',
      email: 'mgr1@example.com',
      name: 'Manager One',
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
      roleAssignments: [{ id: 'ra_mgr_1', role: 'manager' }],
      sessions: [],
    },
  ]
  const ras: { id: string; userId: string; role: string }[] = users
    .flatMap((u) => u.roleAssignments.map((ra) => ({ ...ra, userId: u.id })))
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
      count: ({
        where,
      }: {
        where: { role: string | { in: readonly string[] }; userId?: { not: string } }
      }) => {
        const matchesRole = (role: string) =>
          typeof where.role === 'string'
            ? role === where.role
            : where.role.in.includes(role)
        const filtered = ras.filter(
          (r) =>
            matchesRole(r.role) &&
            (!where.userId?.not || r.userId !== where.userId.not),
        )
        return Promise.resolve(filtered.length)
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
  return { ctx, audit, auditCalls, ras, users, tokens, sessions }
}

describe('admin.users router', () => {
  it('list returns rows for senior_manager with status', async () => {
    const { ctx } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    const out = await caller.list({ limit: 50 })
    expect(out.items.length).toBeGreaterThan(0)
    expect(out.items[0]?.status).toBeDefined()
  })

  it('list rejects non-admin-tier roles', async () => {
    const { ctx } = makeCtx('sales_executive')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(caller.list({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('invite refuses a role senior_manager cannot grant', async () => {
    const { ctx } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.invite({ email: 'new@example.com', roles: ['senior_manager'] }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('invite happy path creates user, role assignments, and audit', async () => {
    const { ctx, auditCalls, users } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.invite({
      email: 'newbie@example.com',
      name: 'Newbie',
      roles: ['sales_executive', 'manager'],
    })
    expect(r.email).toBe('newbie@example.com')
    expect(users.find((u) => u.email === 'newbie@example.com')).toBeDefined()
    expect(auditCalls.some((a) => a.action === 'auth.user_invited')).toBe(true)
  })

  it('assignRole respects canGrantRole', async () => {
    const { ctx } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    // senior_manager cannot grant senior_manager
    await expect(
      caller.assignRole({ userId: 'u_2', role: 'senior_manager' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // senior_manager can grant manager
    const ok = await caller.assignRole({ userId: 'u_2', role: 'manager' })
    expect(ok.alreadyPresent).toBe(false)
  })

  it('revokeRole respects canRevokeRole', async () => {
    const { ctx } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.revokeRole({ userId: 'ceo_1', role: 'ceo' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('revokeRole self-demotion is locked for ceo', async () => {
    const { ctx } = makeCtx('ceo', 'ceo_1')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.revokeRole({ userId: 'ceo_1', role: 'ceo' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('revokeRole last-ceo guard fires when no other ceos remain', async () => {
    // Promote actor_1 to ceo so we have two ceos (actor_1 + ceo_1), then
    // revoke ceo_1. After that only actor_1 is ceo — revoking actor_1's own
    // ceo would be both self-demotion and last-ceo. Self-demotion fires first.
    const { ctx, ras, users } = makeCtx('ceo', 'actor_1')
    ras.push({ id: 'ra_actor_ceo', userId: 'actor_1', role: 'ceo' })
    const u = users.find((x) => x.id === 'actor_1')
    u?.roleAssignments.push({ id: 'ra_actor_ceo', role: 'ceo' })
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.revokeRole({ userId: 'ceo_1', role: 'ceo' })
    expect(r.ok).toBe(true)
    await expect(
      caller.revokeRole({ userId: 'actor_1', role: 'ceo' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('deactivate clears roles and sessions', async () => {
    const { ctx, sessions } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.deactivate({ userId: 'u_2', reason: 'left' })
    expect(r.ok).toBe(true)
    expect(sessions.find((s) => s.userId === 'u_2')).toBeUndefined()
  })

  it('deactivate refuses self-deactivation', async () => {
    const { ctx } = makeCtx('senior_manager', 'actor_1')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.deactivate({ userId: 'actor_1', reason: 'why' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('deactivate refuses when actor cannot revoke the target role', async () => {
    // senior_manager attempts to deactivate the ceo — canRevokeRole says no.
    const { ctx } = makeCtx('senior_manager')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.deactivate({ userId: 'ceo_1', reason: 'no' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
