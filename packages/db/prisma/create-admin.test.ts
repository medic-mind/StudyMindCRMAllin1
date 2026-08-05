// Tests for the general-purpose admin-account CLI (the multi-admin counterpart
// of seed-super-admin.ts). Same security posture: generate-or-take a strong
// password on create, never overwrite an existing password without an explicit
// force flag, grant the role idempotently, convert a legacy super_admin row.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/index', () => {
  type U = {
    id: string
    email: string
    name: string | null
    passwordHash: string | null
    emailVerifiedAt: Date | null
    mustResetPassword: boolean
    failedSignInAttempts: number
    lockedUntil: Date | null
    deactivatedAt: Date | null
  }
  type RA = { id: string; userId: string; role: string }
  type AL = { id: string; action: string; targetId: string }

  const state: { users: U[]; ras: RA[]; audits: AL[] } = { users: [], ras: [], audits: [] }

  const db = {
    user: {
      findUnique: ({ where }: { where: { email?: string; id?: string } }) =>
        Promise.resolve(
          state.users.find(
            (u) => (where.email && u.email === where.email) || (where.id && u.id === where.id),
          ) ?? null,
        ),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          failedSignInAttempts: 0,
          lockedUntil: null,
          deactivatedAt: null,
          ...data,
        } as U
        state.users.push(row)
        return Promise.resolve(row)
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<U> }) => {
        const row = state.users.find((u) => u.id === where.id)
        if (row) Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
    roleAssignment: {
      findUnique: ({ where }: { where: { userId_role: { userId: string; role: string } } }) =>
        Promise.resolve(
          state.ras.find(
            (r) => r.userId === where.userId_role.userId && r.role === where.userId_role.role,
          ) ?? null,
        ),
      update: ({ where, data }: { where: { id: string }; data: Partial<RA> }) => {
        const row = state.ras.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        return Promise.resolve(row)
      },
      create: ({ data }: { data: RA }) => {
        state.ras.push(data)
        return Promise.resolve(data)
      },
    },
    auditLogEntry: {
      create: ({ data }: { data: AL }) => {
        state.audits.push(data)
        return Promise.resolve(data)
      },
    },
    __state: state,
    __reset: () => {
      state.users.length = 0
      state.ras.length = 0
      state.audits.length = 0
    },
    $disconnect: () => Promise.resolve(),
  }
  return { db }
})

type MockDb = {
  __reset: () => void
  __state: {
    users: Array<{
      id: string
      email: string
      name: string | null
      passwordHash: string
      mustResetPassword: boolean
      deactivatedAt: Date | null
      lockedUntil: Date | null
    }>
    ras: Array<{ id: string; userId: string; role: string }>
    audits: Array<{ id: string; action: string; targetId: string }>
  }
}

describe('createAdminAccount', () => {
  let mod: { db: MockDb }

  beforeEach(async () => {
    mod = (await import('../src/index')) as unknown as { db: MockDb }
    mod.db.__reset()
  })

  afterEach(() => {
    mod.db.__reset()
  })

  it('creates the user with a generated password, forced reset and the ceo role', async () => {
    const { createAdminAccount } = await import('./create-admin')
    const r = await createAdminAccount({ email: 'Info@MedicMind.co.uk', name: 'Info' })

    expect(r.email).toBe('info@medicmind.co.uk') // normalised
    expect(r.alreadyExisted).toBe(false)
    expect(r.passwordAction).toBe('created')
    expect(r.roleAction).toBe('granted')
    expect(r.role).toBe('ceo')
    expect((r.generatedPassword ?? '').length).toBeGreaterThanOrEqual(12)

    expect(mod.db.__state.users).toHaveLength(1)
    expect(mod.db.__state.users[0]?.mustResetPassword).toBe(true)
    expect(mod.db.__state.ras[0]?.role).toBe('ceo')
  })

  it('ships no hard-coded default password', async () => {
    const { createAdminAccount } = await import('./create-admin')
    const r = await createAdminAccount({ email: 'a@b.co' })
    expect(r.generatedPassword).not.toBe('Wenger20')
  })

  it('audits creation and the role grant', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    const actions = mod.db.__state.audits.map((a) => a.action)
    expect(actions).toContain('auth.user_created')
    expect(actions).toContain('auth.role_granted')
  })

  it('is idempotent: re-running leaves the password alone and does not duplicate the role', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    const firstHash = mod.db.__state.users[0]!.passwordHash

    const second = await createAdminAccount({ email: 'a@b.co', password: 'DifferentPassword42' })

    expect(second.alreadyExisted).toBe(true)
    expect(second.passwordAction).toBe('unchanged')
    expect(second.roleAction).toBe('already_present')
    expect(mod.db.__state.users[0]!.passwordHash).toBe(firstHash)
    expect(mod.db.__state.ras).toHaveLength(1)
  })

  it('resets an existing password only with the explicit force flag', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    const firstHash = mod.db.__state.users[0]!.passwordHash

    const second = await createAdminAccount({
      email: 'a@b.co',
      password: 'RecoveryPassword42',
      forcePasswordReset: true,
    })

    expect(second.passwordAction).toBe('reset')
    expect(mod.db.__state.users[0]!.passwordHash).not.toBe(firstHash)
    expect(mod.db.__state.users[0]!.mustResetPassword).toBe(true)
  })

  it('clears a lockout / deactivation on a recovery reset', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    mod.db.__state.users[0]!.deactivatedAt = new Date()
    mod.db.__state.users[0]!.lockedUntil = new Date()

    const r = await createAdminAccount({
      email: 'a@b.co',
      password: 'RecoveryPassword42',
      forcePasswordReset: true,
    })

    expect(r.clearedLockout).toBe(true)
    expect(mod.db.__state.users[0]!.deactivatedAt).toBeNull()
    expect(mod.db.__state.users[0]!.lockedUntil).toBeNull()
  })

  it('refuses a force reset with no password to reset to', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    await expect(createAdminAccount({ email: 'a@b.co', forcePasswordReset: true })).rejects.toThrow(
      /nothing to reset to/i,
    )
  })

  it('rejects a weak password rather than storing it', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await expect(createAdminAccount({ email: 'a@b.co', password: 'short1' })).rejects.toThrow(
      /at least 12 characters/i,
    )
    await expect(
      createAdminAccount({ email: 'a@b.co', password: 'alllowercaseletters' }),
    ).rejects.toThrow(/3 of/i)
  })

  it('converts a legacy super_admin assignment to ceo in place', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await createAdminAccount({ email: 'a@b.co' })
    const userId = mod.db.__state.users[0]!.id
    mod.db.__state.ras[0] = { id: 'ra_legacy', userId, role: 'super_admin' }

    const r = await createAdminAccount({ email: 'a@b.co' })

    expect(r.roleAction).toBe('converted_from_legacy')
    expect(mod.db.__state.ras).toHaveLength(1)
    expect(mod.db.__state.ras[0]?.role).toBe('ceo')
    expect(mod.db.__state.ras[0]?.id).toBe('ra_legacy')
  })

  it('supports granting a non-ceo canonical role', async () => {
    const { createAdminAccount } = await import('./create-admin')
    const r = await createAdminAccount({ email: 'a@b.co', role: 'senior_manager' })
    expect(r.role).toBe('senior_manager')
    expect(mod.db.__state.ras[0]?.role).toBe('senior_manager')
  })

  it('rejects an argument that is not an email address', async () => {
    const { createAdminAccount } = await import('./create-admin')
    await expect(createAdminAccount({ email: 'Their Name' })).rejects.toThrow(/email address/i)
  })
})

describe('parseRole', () => {
  it('defaults to ceo and accepts canonical roles', async () => {
    const { parseRole } = await import('./create-admin')
    expect(parseRole(undefined)).toBe('ceo')
    expect(parseRole('MANAGER')).toBe('manager')
  })

  it('rejects a legacy or unknown role', async () => {
    const { parseRole } = await import('./create-admin')
    expect(() => parseRole('super_admin')).toThrow(/must be one of/i)
    expect(() => parseRole('wizard')).toThrow(/must be one of/i)
  })
})
