// Tests for the CEO bootstrap seed (ADR 0014 + the 2026-07 security fix).
// The seed is NON-DESTRUCTIVE: it creates the CEO on first bootstrap (with an
// env password or a generated one, forcing a first-login reset), never
// overwrites an existing password on a plain redeploy, and only resets an
// existing password behind the explicit SUPER_ADMIN_FORCE_PASSWORD_RESET flag.
// A legacy `super_admin` row on the same user is converted to `ceo` in place.

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

  const state: { users: U[]; ras: RA[] } = { users: [], ras: [] }

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
      findUnique: ({
        where,
      }: {
        where: { userId_role: { userId: string; role: string } }
      }) =>
        Promise.resolve(
          state.ras.find(
            (r) =>
              r.userId === where.userId_role.userId && r.role === where.userId_role.role,
          ) ?? null,
        ),
      update: ({ where, data }: { where: { id: string }; data: Partial<RA> }) => {
        const row = state.ras.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        return Promise.resolve(row)
      },
      upsert: ({
        where,
        create,
      }: {
        where: { userId_role: { userId: string; role: string } }
        update: Record<string, unknown>
        create: RA
      }) => {
        const existing = state.ras.find(
          (r) => r.userId === where.userId_role.userId && r.role === where.userId_role.role,
        )
        if (existing) return Promise.resolve(existing)
        state.ras.push(create)
        return Promise.resolve(create)
      },
    },
    __state: state,
    __reset: () => {
      state.users.length = 0
      state.ras.length = 0
    },
    $disconnect: () => Promise.resolve(),
  }
  return { db }
})

const ENV_KEYS = [
  'SUPER_ADMIN_EMAIL',
  'SUPER_ADMIN_PASSWORD',
  'INITIAL_SUPER_ADMIN_EMAIL',
  'INITIAL_SUPER_ADMIN_PASSWORD',
  'SUPER_ADMIN_FORCE_PASSWORD_RESET',
  'SUPER_ADMIN_SKIP_FORCE_RESET',
] as const

describe('seedInitialSuperAdmin (non-destructive CEO bootstrap)', () => {
  type MockUser = {
    id: string
    passwordHash: string
    mustResetPassword: boolean
  }
  type MockDb = {
    __reset: () => void
    __state: {
      users: MockUser[]
      ras: Array<{ id: string; userId: string; role: string }>
    }
  }
  let mod: { db: MockDb }

  beforeEach(async () => {
    mod = (await import('../src/index')) as unknown as { db: MockDb }
    mod.db.__reset()
    for (const k of ENV_KEYS) delete process.env[k]
    vi.resetModules()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k]
  })

  it('creates the ceo row with a generated password + forced reset when env unset', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('aashir@studymind.co.uk')
    expect(r.alreadyExisted).toBe(false)
    expect(r.passwordAction).toBe('created')
    // A strong password was generated (no env supplied) and is returned once.
    expect(r.generatedPassword).toBeTruthy()
    expect((r.generatedPassword ?? '').length).toBeGreaterThanOrEqual(12)
    expect(mod.db.__state.users).toHaveLength(1)
    expect(mod.db.__state.users[0]?.mustResetPassword).toBe(true)
    expect(mod.db.__state.ras[0]?.role).toBe('ceo')
  })

  it('does NOT ship a hard-coded default password', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const r = await seedInitialSuperAdmin()
    // The old fallback was 'Wenger20'; the generated password must never be it.
    expect(r.generatedPassword).not.toBe('Wenger20')
  })

  it('does NOT overwrite an existing password on a plain redeploy', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    await seedInitialSuperAdmin()
    const firstHash = mod.db.__state.users[0]!.passwordHash

    // Re-run with a different env password but NO force flag → password kept.
    process.env['SUPER_ADMIN_PASSWORD'] = 'DifferentPassword42'
    vi.resetModules()
    const { seedInitialSuperAdmin: seedAgain } = await import('./seed-super-admin')
    const second = await seedAgain()

    expect(second.alreadyExisted).toBe(true)
    expect(second.passwordAction).toBe('unchanged')
    expect(mod.db.__state.users[0]!.passwordHash).toBe(firstHash)
  })

  it('resets an existing password only with the explicit force flag', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    await seedInitialSuperAdmin()
    const firstHash = mod.db.__state.users[0]!.passwordHash

    process.env['SUPER_ADMIN_PASSWORD'] = 'RecoveryPassword42'
    process.env['SUPER_ADMIN_FORCE_PASSWORD_RESET'] = 'true'
    vi.resetModules()
    const { seedInitialSuperAdmin: seedAgain } = await import('./seed-super-admin')
    const second = await seedAgain()

    expect(second.passwordAction).toBe('reset')
    expect(mod.db.__state.users[0]!.passwordHash).not.toBe(firstHash)
    expect(mod.db.__state.users[0]!.mustResetPassword).toBe(true)
  })

  it('rejects a weak env password (too short) rather than seeding it', async () => {
    process.env['SUPER_ADMIN_PASSWORD'] = 'short1'
    vi.resetModules()
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    await expect(seedInitialSuperAdmin()).rejects.toThrow(/at least 12 characters/i)
  })

  it('converts a legacy super_admin assignment to ceo in place', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    await seedInitialSuperAdmin()
    const userId = mod.db.__state.users[0]!.id
    mod.db.__state.ras[0] = { id: 'ra_legacy', userId, role: 'super_admin' }
    vi.resetModules()
    const { seedInitialSuperAdmin: seedAgain } = await import('./seed-super-admin')
    await seedAgain()
    expect(mod.db.__state.ras).toHaveLength(1)
    expect(mod.db.__state.ras[0]?.role).toBe('ceo')
    expect(mod.db.__state.ras[0]?.id).toBe('ra_legacy')
  })

  it('honours SUPER_ADMIN_EMAIL override', async () => {
    process.env['SUPER_ADMIN_EMAIL'] = 'someone-else@studymind.co.uk'
    vi.resetModules()
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('someone-else@studymind.co.uk')
  })
})
