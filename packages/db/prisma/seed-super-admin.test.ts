// Tests for the simplified ceo seed (ADR 0014). The seed is intentionally
// simple: always upsert, always set the password from env, always ensure
// the ceo role. No idempotency dance, no email-link flow. A legacy
// `super_admin` row on the same user is converted to `ceo` in place.

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
      upsert: ({
        where,
        update,
        create,
      }: {
        where: { email: string }
        update: Partial<U>
        create: U
      }) => {
        const existing = state.users.find((u) => u.email === where.email)
        if (existing) {
          Object.assign(existing, update)
          return Promise.resolve(existing)
        }
        state.users.push(create)
        return Promise.resolve(create)
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
      update: ({
        where,
        data,
      }: {
        where: { id: string }
        data: Partial<RA>
      }) => {
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

describe('seedInitialSuperAdmin (simplified, ADR 0014 ceo)', () => {
  type MockDb = {
    __reset: () => void
    __state: {
      users: Array<{ id: string; passwordHash: string }>
      ras: Array<{ id: string; userId: string; role: string }>
    }
  }
  let mod: { db: MockDb }

  beforeEach(async () => {
    mod = (await import('../src/index')) as unknown as { db: MockDb }
    mod.db.__reset()
    delete process.env['SUPER_ADMIN_EMAIL']
    delete process.env['SUPER_ADMIN_PASSWORD']
    delete process.env['INITIAL_SUPER_ADMIN_EMAIL']
    delete process.env['INITIAL_SUPER_ADMIN_PASSWORD']
    vi.resetModules()
  })

  afterEach(() => {
    delete process.env['SUPER_ADMIN_EMAIL']
    delete process.env['SUPER_ADMIN_PASSWORD']
  })

  it('creates the ceo row with default email when env unset', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('aashir@studymind.co.uk')
    expect(r.alreadyExisted).toBe(false)
    expect(mod.db.__state.users).toHaveLength(1)
    expect(mod.db.__state.ras).toHaveLength(1)
    expect(mod.db.__state.ras[0]?.role).toBe('ceo')
  })

  it('converts a legacy super_admin assignment to ceo in place', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    // Pre-seed a legacy row for the default email's user. The seed will
    // create the user, find the legacy RA, and convert it.
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

  it('overwrites the existing password on re-run (no idempotency guard)', async () => {
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const first = await seedInitialSuperAdmin()
    const firstHash = mod.db.__state.users[0]!.passwordHash

    process.env['SUPER_ADMIN_PASSWORD'] = 'DifferentPassword42'
    vi.resetModules()
    const { seedInitialSuperAdmin: seedAgain } = await import('./seed-super-admin')
    const second = await seedAgain()
    const secondHash = mod.db.__state.users[0]!.passwordHash

    expect(second.userId).toBe(first.userId)
    expect(second.alreadyExisted).toBe(true)
    expect(secondHash).not.toBe(firstHash)
    expect(mod.db.__state.ras).toHaveLength(1) // role not duplicated
  })

  it('honours SUPER_ADMIN_EMAIL override', async () => {
    process.env['SUPER_ADMIN_EMAIL'] = 'someone-else@studymind.co.uk'
    vi.resetModules()
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('someone-else@studymind.co.uk')
  })

  it('honours legacy INITIAL_SUPER_ADMIN_PASSWORD env name', async () => {
    process.env['INITIAL_SUPER_ADMIN_PASSWORD'] = 'LegacyName123'
    vi.resetModules()
    const { seedInitialSuperAdmin } = await import('./seed-super-admin')
    await seedInitialSuperAdmin()
    expect(mod.db.__state.users).toHaveLength(1)
  })
})
