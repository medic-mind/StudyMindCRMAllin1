// Tests for unauthenticated auth server actions. ADR 0010.
// Mocks Prisma + Resend + audit and walks the four key paths:
//   - signUp creates User + token, sends email
//   - requestPasswordReset is enumeration-safe
//   - verifyEmail flips emailVerifiedAt + invalidates the token
//   - resetPassword rotates the password and clears lockout

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/headers', () => ({
  headers: async () => new Headers([['x-forwarded-for', '1.2.3.4']]),
}))

const mocks = vi.hoisted(() => ({
  sendEmail: vi.fn(async () => ({ status: 'sent' as const, id: 'm1' })),
  writeAudit: vi.fn(async () => 'audit-id'),
}))

vi.mock('@studymind/integration-resend', () => ({
  sendEmail: mocks.sendEmail,
}))

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: mocks.writeAudit,
}))

interface UserRow {
  id: string
  email: string
  name: string | null
  passwordHash: string | null
  emailVerifiedAt: Date | null
  failedSignInAttempts: number
  lockedUntil: Date | null
  mustResetPassword: boolean
}

interface TokenRow {
  id: string
  userId: string
  tokenHash: string
  expiresAt: Date
  usedAt: Date | null
}

const state = vi.hoisted(() => {
  interface UR {
    id: string
    email: string
    name: string | null
    passwordHash: string | null
    emailVerifiedAt: Date | null
    failedSignInAttempts: number
    lockedUntil: Date | null
    mustResetPassword: boolean
  }
  interface TR {
    id: string
    userId: string
    tokenHash: string
    expiresAt: Date
    usedAt: Date | null
  }
  return { users: [] as UR[], evt: [] as TR[], prt: [] as TR[] }
})

vi.mock('@studymind/db', () => {
  const findUniqueUser = vi.fn(async (args: { where: { email?: string; id?: string } }) => {
    const w = args.where
    return (
      state.users.find(
        (u) => (w.email && u.email === w.email) || (w.id && u.id === w.id),
      ) ?? null
    )
  })
  const createUser = vi.fn(async (args: { data: Partial<UserRow> & { id: string; email: string } }) => {
    const row: UserRow = {
      id: args.data.id,
      email: args.data.email,
      name: args.data.name ?? null,
      passwordHash: args.data.passwordHash ?? null,
      emailVerifiedAt: args.data.emailVerifiedAt ?? null,
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: args.data.mustResetPassword ?? false,
    }
    state.users.push(row)
    return row
  })
  const updateUser = vi.fn(async (args: { where: { id: string }; data: Partial<UserRow> }) => {
    const u = state.users.find((x) => x.id === args.where.id)
    if (!u) throw new Error('not found')
    Object.assign(u, args.data)
    return u
  })

  function tokenStore(rows: TokenRow[]) {
    return {
      create: vi.fn(async (args: { data: TokenRow }) => {
        rows.push(args.data)
        return args.data
      }),
      findUnique: vi.fn(async (args: { where: { tokenHash: string } }) => {
        return rows.find((r) => r.tokenHash === args.where.tokenHash) ?? null
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Partial<TokenRow> }) => {
        const r = rows.find((x) => x.id === args.where.id)
        if (!r) throw new Error('not found')
        Object.assign(r, args.data)
        return r
      }),
    }
  }

  const evtStore = tokenStore(state.evt)
  const prtStore = tokenStore(state.prt)

  return {
    db: {
      user: {
        findUnique: findUniqueUser,
        create: createUser,
        update: updateUser,
      },
      emailVerificationToken: evtStore,
      passwordResetToken: prtStore,
      $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
    },
  }
})

import { _resetAuthRateLimit } from './rate-limit-handler'
import {
  requestPasswordReset,
  resetPassword,
  signUp,
  verifyEmail,
} from './server-actions'

beforeEach(() => {
  state.users.length = 0
  state.evt.length = 0
  state.prt.length = 0
  mocks.sendEmail.mockClear()
  mocks.writeAudit.mockClear()
  _resetAuthRateLimit()
})

describe('signUp', () => {
  it('creates a user, an email token, and sends a verification email', async () => {
    const res = await signUp({
      email: 'New@Example.COM',
      password: 'CorrectHorse-Battery-1',
      name: 'New User',
    })
    expect(res).toEqual({ ok: true })
    expect(state.users).toHaveLength(1)
    expect(state.users[0]!.email).toBe('new@example.com')
    expect(state.users[0]!.passwordHash).toBeTruthy()
    expect(state.users[0]!.emailVerifiedAt).toBeNull()
    expect(state.evt).toHaveLength(1)
    expect(mocks.sendEmail).toHaveBeenCalledOnce()
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'auth.signup_started' }),
    )
  })

  it('returns the generic error when an account with a password already exists', async () => {
    state.users.push({
      id: 'u1',
      email: 'taken@example.com',
      name: 'Existing',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: false,
    })
    const res = await signUp({
      email: 'taken@example.com',
      password: 'CorrectHorse-Battery-1',
      name: 'Other',
    })
    expect(res.ok).toBe(false)
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('rejects weak passwords', async () => {
    const res = await signUp({ email: 'a@b.com', password: 'short', name: 'X' })
    expect(res.ok).toBe(false)
  })
})

describe('requestPasswordReset', () => {
  it('returns the same generic message whether or not the account exists', async () => {
    const a = await requestPasswordReset('absent@example.com')
    state.users.push({
      id: 'u1',
      email: 'present@example.com',
      name: 'Present',
      passwordHash: 'hash',
      emailVerifiedAt: new Date(),
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: false,
    })
    const b = await requestPasswordReset('present@example.com')
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect((a as { ok: true; message?: string }).message).toBe((b as { ok: true; message?: string }).message)
    }
    // Only the present user should have a reset token issued.
    expect(state.prt).toHaveLength(1)
    expect(state.prt[0]!.userId).toBe('u1')
    expect(mocks.sendEmail).toHaveBeenCalledOnce()
  })
})

describe('verifyEmail', () => {
  it('marks the user verified and invalidates the token', async () => {
    state.users.push({
      id: 'u1',
      email: 'a@b.com',
      name: 'A',
      passwordHash: 'hash',
      emailVerifiedAt: null,
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: false,
    })
    const { hashToken } = await import('@studymind/core/auth/passwords')
    const token = 'rawtoken123'
    state.evt.push({
      id: 'e1',
      userId: 'u1',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    })
    const res = await verifyEmail(token)
    expect(res.ok).toBe(true)
    expect(state.users[0]!.emailVerifiedAt).toBeInstanceOf(Date)
    expect(state.evt[0]!.usedAt).toBeInstanceOf(Date)

    // Re-using the same token must fail.
    const res2 = await verifyEmail(token)
    expect(res2.ok).toBe(false)
  })

  it('rejects an expired token', async () => {
    const { hashToken } = await import('@studymind/core/auth/passwords')
    const token = 'expired'
    state.users.push({
      id: 'u2',
      email: 'b@b.com',
      name: 'B',
      passwordHash: 'h',
      emailVerifiedAt: null,
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: false,
    })
    state.evt.push({
      id: 'e2',
      userId: 'u2',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() - 1000),
      usedAt: null,
    })
    const res = await verifyEmail(token)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('expired')
  })
})

describe('resetPassword', () => {
  it('rotates the password and clears lockout state', async () => {
    state.users.push({
      id: 'u1',
      email: 'reset@example.com',
      name: 'R',
      passwordHash: 'old',
      emailVerifiedAt: new Date(),
      failedSignInAttempts: 4,
      lockedUntil: new Date(Date.now() + 60_000),
      mustResetPassword: true,
    })
    const { hashToken } = await import('@studymind/core/auth/passwords')
    const token = 'reset-tok-abc'
    state.prt.push({
      id: 'p1',
      userId: 'u1',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60_000),
      usedAt: null,
    })
    const res = await resetPassword({ token, password: 'CorrectHorse-Battery-9' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.email).toBe('reset@example.com')
    expect(state.users[0]!.passwordHash).not.toBe('old')
    expect(state.users[0]!.failedSignInAttempts).toBe(0)
    expect(state.users[0]!.lockedUntil).toBeNull()
    expect(state.users[0]!.mustResetPassword).toBe(false)
    expect(state.prt[0]!.usedAt).toBeInstanceOf(Date)
  })

  it('rejects an invalid or used token', async () => {
    const res = await resetPassword({ token: 'nope', password: 'CorrectHorse-Battery-9' })
    expect(res.ok).toBe(false)
  })
})
