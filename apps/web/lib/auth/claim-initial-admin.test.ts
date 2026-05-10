// Tests for claimInitialAdmin — the first-run super_admin bootstrap path.
// Verifies the self-disabling invariant, the role gate, the not-yet-seeded
// branch, and the happy path.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => new Headers([['x-forwarded-for', '1.2.3.4']]),
}))

const mocks = vi.hoisted(() => ({
  writeAudit: vi.fn(async () => 'audit-id'),
  hashPassword: vi.fn(async (p: string) => `hashed:${p}`),
}))

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: mocks.writeAudit,
}))

vi.mock('@studymind/integration-resend', () => ({
  sendEmail: vi.fn(async () => ({ status: 'sent' as const, id: 'm1' })),
}))

vi.mock('@studymind/core/auth/passwords', async () => {
  const real = await vi.importActual<
    typeof import('@studymind/core/auth/passwords')
  >('@studymind/core/auth/passwords')
  return { ...real, hashPassword: mocks.hashPassword }
})

interface UserRow {
  id: string
  email: string
  passwordHash: string | null
  deactivatedAt: Date | null
  roles: string[]
}

const state = vi.hoisted(() => ({ users: [] as UserRow[] }))

vi.mock('@studymind/db', () => {
  function matchesUser(u: UserRow, where: Record<string, unknown>): boolean {
    if (where['email'] && u.email !== where['email']) return false
    if (where['id'] && u.id !== where['id']) return false
    if ('passwordHash' in where) {
      const cond = where['passwordHash'] as { not?: null } | null
      if (cond && typeof cond === 'object' && 'not' in cond) {
        if (cond.not === null && u.passwordHash === null) return false
      }
    }
    if ('deletedAt' in where && where['deletedAt'] === null) {
      // we don't model deletedAt — always considered alive
    }
    if (where['roleAssignments']) {
      const ra = where['roleAssignments'] as {
        some?: { role: string }
      }
      if (ra.some?.role && !u.roles.includes(ra.some.role)) return false
    }
    return true
  }

  const findFirst = vi.fn(async (args: { where: Record<string, unknown> }) => {
    return state.users.find((u) => matchesUser(u, args.where)) ?? null
  })
  const findUnique = vi.fn(
    async (args: {
      where: { email?: string; id?: string }
      select?: { roleAssignments?: unknown }
    }) => {
      const u = state.users.find(
        (u) =>
          (args.where.email && u.email === args.where.email) ||
          (args.where.id && u.id === args.where.id),
      )
      if (!u) return null
      // Mirror Prisma's select-with-relation shape so the caller can read
      // `user.roleAssignments[].role`.
      return {
        ...u,
        roleAssignments: u.roles.map((role) => ({ role })),
      }
    },
  )
  const updateUser = vi.fn(
    async (args: { where: { id: string }; data: Partial<UserRow> }) => {
      const u = state.users.find((x) => x.id === args.where.id)
      if (!u) throw new Error('not found')
      Object.assign(u, args.data)
      return u
    },
  )
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn({
      user: { findFirst, update: updateUser },
    })
  })

  return {
    db: {
      user: { findFirst, findUnique, update: updateUser },
      $transaction: transaction,
    },
  }
})

import { _resetAuthRateLimit } from './rate-limit-handler'
import { claimInitialAdmin } from './server-actions'

beforeEach(() => {
  state.users.length = 0
  mocks.writeAudit.mockClear()
  mocks.hashPassword.mockClear()
  _resetAuthRateLimit()
})

describe('claimInitialAdmin', () => {
  it('returns an error when no super_admin has been seeded', async () => {
    const res = await claimInitialAdmin({
      email: 'aashir@studymind.co.uk',
      password: 'CorrectHorse-Battery-1',
    })
    expect(res.ok).toBe(false)
    expect(mocks.hashPassword).not.toHaveBeenCalled()
  })

  it('sets the password on the happy path and audits', async () => {
    state.users.push({
      id: 'u1',
      email: 'aashir@studymind.co.uk',
      passwordHash: null,
      deactivatedAt: null,
      roles: ['super_admin'],
    })
    const res = await claimInitialAdmin({
      email: 'aashir@studymind.co.uk',
      password: 'CorrectHorse-Battery-1',
    })
    expect(res).toEqual({ ok: true, email: 'aashir@studymind.co.uk' })
    expect(state.users[0]!.passwordHash).toBe('hashed:CorrectHorse-Battery-1')
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.super_admin_claimed' }),
    )
  })

  it('refuses once any super_admin has a password', async () => {
    state.users.push({
      id: 'u1',
      email: 'aashir@studymind.co.uk',
      passwordHash: 'already-set',
      deactivatedAt: null,
      roles: ['super_admin'],
    })
    const res = await claimInitialAdmin({
      email: 'aashir@studymind.co.uk',
      password: 'CorrectHorse-Battery-1',
    })
    expect(res.ok).toBe(false)
    expect(mocks.hashPassword).not.toHaveBeenCalled()
  })

  it('refuses when the targeted user is not a super_admin', async () => {
    // A super_admin exists without a password (so the page renders),
    // but the caller submits the wrong email — must not grant.
    state.users.push({
      id: 'u1',
      email: 'aashir@studymind.co.uk',
      passwordHash: null,
      deactivatedAt: null,
      roles: ['super_admin'],
    })
    state.users.push({
      id: 'u2',
      email: 'agent@studymind.co.uk',
      passwordHash: null,
      deactivatedAt: null,
      roles: ['agent'],
    })
    const res = await claimInitialAdmin({
      email: 'agent@studymind.co.uk',
      password: 'CorrectHorse-Battery-1',
    })
    expect(res.ok).toBe(false)
    expect(state.users[1]!.passwordHash).toBeNull()
  })

  it('rejects a weak password', async () => {
    state.users.push({
      id: 'u1',
      email: 'aashir@studymind.co.uk',
      passwordHash: null,
      deactivatedAt: null,
      roles: ['super_admin'],
    })
    const res = await claimInitialAdmin({
      email: 'aashir@studymind.co.uk',
      password: 'short',
    })
    expect(res.ok).toBe(false)
    expect(state.users[0]!.passwordHash).toBeNull()
  })
})
