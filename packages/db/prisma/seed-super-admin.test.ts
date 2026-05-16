// Tests for the initial super_admin seed. Verifies idempotency and that
// the password vs link paths behave as documented. CLAUDE.md §20.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the prisma client this script imports.
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
  }
  type RA = { id: string; userId: string; role: string }
  type EVT = { id: string; userId: string; tokenHash: string; expiresAt: Date; usedAt: Date | null }

  const state: { users: U[]; ras: RA[]; tokens: EVT[] } = {
    users: [],
    ras: [],
    tokens: [],
  }

  const db = {
    user: {
      findUnique: ({ where }: { where: { email?: string; id?: string } }) =>
        Promise.resolve(
          (where.email
            ? state.users.find((u) => u.email === where.email)
            : state.users.find((u) => u.id === where.id)) ?? null,
        ),
      create: ({ data }: { data: Partial<U> & { id: string; email: string } }) => {
        const u: U = {
          id: data.id,
          email: data.email,
          name: data.name ?? null,
          passwordHash: data.passwordHash ?? null,
          emailVerifiedAt: data.emailVerifiedAt ?? null,
          mustResetPassword: data.mustResetPassword ?? false,
          failedSignInAttempts: 0,
          lockedUntil: null,
        }
        state.users.push(u)
        return Promise.resolve(u)
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<U> }) => {
        const u = state.users.find((x) => x.id === where.id)
        if (u) Object.assign(u, data)
        return Promise.resolve(u)
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
      create: ({ data }: { data: { id: string; userId: string; role: string } }) => {
        state.ras.push({ id: data.id, userId: data.userId, role: data.role })
        return Promise.resolve(data)
      },
    },
    emailVerificationToken: {
      create: ({
        data,
      }: {
        data: { id: string; userId: string; tokenHash: string; expiresAt: Date }
      }) => {
        state.tokens.push({ ...data, usedAt: null })
        return Promise.resolve(data)
      },
    },
    auditLogEntry: {
      create: () => Promise.resolve({ id: 'a' }),
    },
    $disconnect: () => Promise.resolve(),
  }

  return { db, __state: state }
})

import { seedInitialSuperAdmin } from './seed-super-admin'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod = (await import('../src/index')) as any

describe('seedInitialSuperAdmin', () => {
  beforeEach(() => {
    mod.__state.users.length = 0
    mod.__state.ras.length = 0
    mod.__state.tokens.length = 0
    delete process.env['INITIAL_SUPER_ADMIN_PASSWORD']
    delete process.env['INITIAL_SUPER_ADMIN_EMAIL']
    delete process.env['INITIAL_SUPER_ADMIN_NAME']
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a User, grants super_admin, and bakes the default password on first run', async () => {
    // No INITIAL_SUPER_ADMIN_PASSWORD env → seed falls back to the baked
    // default ("Wenger20") so a fresh deploy is signable-in immediately.
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('aashir@studymind.co.uk')
    expect(r.status).toBe('password-set')
    expect(r.inviteUrl).toBeUndefined()
    expect(r.alreadySuperAdmin).toBe(false)
    expect(mod.__state.users).toHaveLength(1)
    expect(mod.__state.users[0].passwordHash).toBeTruthy()
    // mustResetPassword=false: operator can sign in with the baked password
    // and rotate at their own pace.
    expect(mod.__state.users[0].mustResetPassword).toBe(false)
    expect(mod.__state.ras).toHaveLength(1)
    expect(mod.__state.ras[0].role).toBe('super_admin')
    // No EmailVerificationToken — link path is reserved for the explicit
    // INITIAL_SUPER_ADMIN_PASSWORD='' opt-out.
    expect(mod.__state.tokens).toHaveLength(0)
  })

  it('is idempotent — re-running does not duplicate the role assignment', async () => {
    await seedInitialSuperAdmin()
    const second = await seedInitialSuperAdmin()
    expect(mod.__state.users).toHaveLength(1)
    expect(mod.__state.ras).toHaveLength(1)
    expect(second.alreadySuperAdmin).toBe(true)
  })

  it('honours INITIAL_SUPER_ADMIN_EMAIL and INITIAL_SUPER_ADMIN_NAME', async () => {
    process.env['INITIAL_SUPER_ADMIN_EMAIL'] = 'someone@example.com'
    process.env['INITIAL_SUPER_ADMIN_NAME'] = 'Some One'
    const r = await seedInitialSuperAdmin()
    expect(r.email).toBe('someone@example.com')
    expect(mod.__state.users[0].name).toBe('Some One')
  })

  it('honours an explicit INITIAL_SUPER_ADMIN_PASSWORD over the baked default', async () => {
    process.env['INITIAL_SUPER_ADMIN_PASSWORD'] = 'CorrectHorse9!Battery'
    const r = await seedInitialSuperAdmin()
    expect(r.status).toBe('password-set')
    expect(mod.__state.users[0].passwordHash).toBeTruthy()
    expect(mod.__state.users[0].mustResetPassword).toBe(false)
    expect(mod.__state.users[0].emailVerifiedAt).toBeInstanceOf(Date)
    expect(mod.__state.tokens).toHaveLength(0)
  })

  it('link-path opt-out: empty INITIAL_SUPER_ADMIN_PASSWORD issues an invite token with TTL ≈ 7 days', async () => {
    // Explicit empty string disables the password set and falls back to the
    // accept-invite link flow. Useful when an operator wants the first sign-
    // in to come via email link instead of a baked credential.
    process.env['INITIAL_SUPER_ADMIN_PASSWORD'] = ''
    const before = Date.now()
    const r = await seedInitialSuperAdmin()
    expect(r.status).toBe('needs-link')
    expect(mod.__state.users[0].passwordHash).toBeNull()
    expect(mod.__state.tokens).toHaveLength(1)
    const t = mod.__state.tokens[0]
    const ttlMs = t.expiresAt.getTime() - before
    expect(ttlMs).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000)
    expect(ttlMs).toBeLessThan(7.5 * 24 * 60 * 60 * 1000)
  })
})
