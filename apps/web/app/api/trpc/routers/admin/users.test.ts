// Admin users router tests. Exercises role gating, audit, and last-admin guard.
// CLAUDE.md §20, §27.

import { describe, expect, it, vi } from 'vitest'

import type { TrpcContext, SessionUser, AuditRecorder } from '@/lib/trpc/builders'

import { adminUsersRouter } from './users'

interface FakeUser {
  id: string
  email: string
  name: string | null
  isActive: boolean
  deletedAt: Date | null
  roleAssignments: { id: string; role: string }[]
}

function makeCtx(role: SessionUser['role'], userId = 'actor_1') {
  const users: FakeUser[] = [
    {
      id: 'actor_1',
      email: 'actor@example.com',
      name: 'Actor',
      isActive: true,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_actor_admin', role: 'admin' }],
    },
    {
      id: 'u_2',
      email: 'agent@example.com',
      name: 'Ag',
      isActive: true,
      deletedAt: null,
      roleAssignments: [{ id: 'ra_2_agent', role: 'agent' }],
    },
  ]
  const ras: { id: string; userId: string; role: string }[] = [
    { id: 'ra_actor_admin', userId: 'actor_1', role: 'admin' },
    { id: 'ra_2_agent', userId: 'u_2', role: 'agent' },
  ]
  const audit = vi.fn().mockResolvedValue('audit_1') as unknown as AuditRecorder
  ;(audit as unknown as { called: boolean }).called = false
  const wrapped: AuditRecorder = (async (input) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const db = {
    user: {
      findMany: ({ where }: { where: { deletedAt: null; email?: { contains: string } } }) => {
        let rows = users.filter((u) => u.deletedAt === null)
        if (where.email?.contains) {
          const q = where.email.contains.toLowerCase()
          rows = rows.filter((u) => u.email.toLowerCase().includes(q))
        }
        return Promise.resolve(rows)
      },
      findFirst: ({ where }: { where: { id: string; deletedAt: null } }) =>
        Promise.resolve(users.find((u) => u.id === where.id && u.deletedAt === null) ?? null),
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
          if (u) {
            u.roleAssignments = u.roleAssignments.filter((x) => x.id !== r.id)
          }
        }
        return Promise.resolve({ id: where.id })
      },
      count: ({ where }: { where: { role: string } }) =>
        Promise.resolve(ras.filter((r) => r.role === where.role).length),
    },
  }

  const ctx: TrpcContext = {
    user: { id: userId, email: 'a@b.c', role },
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, audit, ras, users }
}

describe('admin.users router', () => {
  it('list returns rows for admin', async () => {
    const { ctx } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const out = await caller.list({ limit: 50 })
    expect(out.items).toHaveLength(2)
    expect(out.items[0]?.roles).toBeDefined()
  })

  it('list rejects non-admin', async () => {
    const { ctx } = makeCtx('agent')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(caller.list({ limit: 50 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('assignRole adds role and audits', async () => {
    const { ctx, audit } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.assignRole({ userId: 'u_2', role: 'finance' })
    expect(r.alreadyPresent).toBe(false)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.role.assign' }),
    )
  })

  it('revokeRole blocks last admin self-revoke', async () => {
    const { ctx } = makeCtx('admin', 'actor_1')
    const caller = adminUsersRouter.createCaller(ctx)
    await expect(
      caller.revokeRole({ userId: 'actor_1', role: 'admin' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('revokeRole removes role and audits when permitted', async () => {
    const { ctx, audit, ras } = makeCtx('admin')
    const caller = adminUsersRouter.createCaller(ctx)
    const r = await caller.revokeRole({ userId: 'u_2', role: 'agent' })
    expect(r.alreadyAbsent).toBe(false)
    expect(ras.find((x) => x.userId === 'u_2' && x.role === 'agent')).toBeUndefined()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'admin.role.revoke' }),
    )
  })
})
