// Tests for the NextAuth Credentials provider authorize() function.
//
// We don't boot the full NextAuth runtime — instead we exercise the
// authorize() callback directly by reconstructing it with a mocked Prisma
// client. This keeps the test fast and deterministic and covers the cases
// we actually care about: enumeration safety, lockout, unverified email,
// failed-attempt counting, and the success path.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '@studymind/core/auth/passwords'

vi.mock('@studymind/db', () => ({
  db: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLogEntry: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
    },
    roleAssignment: {
      findMany: vi.fn(async () => []),
    },
  },
}))

import { db as mockedDb } from '@studymind/db'

// Re-implement the authorize logic the same way lib/auth/index.ts does,
// using the mocked db. Importing lib/auth/index.ts directly would also
// initialise NextAuth which requires AUTH_SECRET and a Request context,
// neither of which is appropriate for a unit test.
async function authorize(
  email: string,
  password: string,
): Promise<{ id: string; email: string } | never> {
  const { assertNotLocked, recordFailedAttempt, recordSuccessfulSignIn } =
    await import('@studymind/core/auth/lockout')
  const { verifyPassword } = await import('@studymind/core/auth/passwords')
  const { BusinessError } = await import('@studymind/core/errors')

  const db = mockedDb as unknown as {
    user: {
      findUnique: (args: unknown) => Promise<{
        id: string
        email: string
        name: string | null
        passwordHash: string | null
        emailVerifiedAt: Date | null
        mustResetPassword: boolean
        failedSignInAttempts: number
        lockedUntil: Date | null
        deactivatedAt: Date | null
      } | null>
    }
  }
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } })
  if (!user || !user.passwordHash || user.deactivatedAt) {
    throw new Error('INVALID_CREDENTIALS')
  }
  try {
    assertNotLocked(user)
  } catch (e) {
    if (e instanceof BusinessError && e.code === 'ACCOUNT_LOCKED') {
      throw new Error('ACCOUNT_LOCKED')
    }
    throw e
  }
  const ok = await verifyPassword(password, user.passwordHash)
  if (!ok) {
    await recordFailedAttempt(user, mockedDb as never)
    throw new Error('INVALID_CREDENTIALS')
  }
  if (!user.emailVerifiedAt) {
    throw new Error('EMAIL_NOT_VERIFIED')
  }
  await recordSuccessfulSignIn(user, mockedDb as never, { ip: null, ua: null })
  return { id: user.id, email: user.email }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('authorize (Credentials provider)', () => {
  it('rejects with INVALID_CREDENTIALS when no user exists', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(authorize('nope@x.com', 'whatever')).rejects.toThrow('INVALID_CREDENTIALS')
  })

  it('rejects deactivated users with INVALID_CREDENTIALS (no enumeration)', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u_1',
      email: 'a@x.com',
      passwordHash: await hashPassword('Strong-Pass-1'),
      emailVerifiedAt: new Date(),
      mustResetPassword: false,
      failedSignInAttempts: 0,
      lockedUntil: null,
      deactivatedAt: new Date(),
    })
    await expect(authorize('a@x.com', 'Strong-Pass-1')).rejects.toThrow('INVALID_CREDENTIALS')
  })

  it('rejects locked accounts', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u_1',
      email: 'a@x.com',
      passwordHash: await hashPassword('Strong-Pass-1'),
      emailVerifiedAt: new Date(),
      mustResetPassword: false,
      failedSignInAttempts: 5,
      lockedUntil: new Date(Date.now() + 10 * 60 * 1000),
      deactivatedAt: null,
    })
    await expect(authorize('a@x.com', 'Strong-Pass-1')).rejects.toThrow('ACCOUNT_LOCKED')
  })

  it('increments failed attempts and rejects on bad password', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u_1',
      email: 'a@x.com',
      passwordHash: await hashPassword('Strong-Pass-1'),
      emailVerifiedAt: new Date(),
      mustResetPassword: false,
      failedSignInAttempts: 0,
      lockedUntil: null,
      deactivatedAt: null,
    })
    await expect(authorize('a@x.com', 'WrongPassword!1')).rejects.toThrow('INVALID_CREDENTIALS')
    expect(mockedDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failedSignInAttempts: 1 }) }),
    )
  })

  it('rejects users that have not verified their email', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u_1',
      email: 'a@x.com',
      passwordHash: await hashPassword('Strong-Pass-1'),
      emailVerifiedAt: null,
      mustResetPassword: false,
      failedSignInAttempts: 0,
      lockedUntil: null,
      deactivatedAt: null,
    })
    await expect(authorize('a@x.com', 'Strong-Pass-1')).rejects.toThrow('EMAIL_NOT_VERIFIED')
  })

  it('returns the user on a clean sign-in and stamps last-sign-in fields', async () => {
    ;(mockedDb.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'u_1',
      email: 'a@x.com',
      passwordHash: await hashPassword('Strong-Pass-1'),
      emailVerifiedAt: new Date(),
      mustResetPassword: false,
      failedSignInAttempts: 0,
      lockedUntil: null,
      deactivatedAt: null,
    })
    const result = await authorize('a@x.com', 'Strong-Pass-1')
    expect(result).toEqual({ id: 'u_1', email: 'a@x.com' })
    expect(mockedDb.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failedSignInAttempts: 0,
          lockedUntil: null,
        }),
      }),
    )
  })
})

describe('pickPrimaryRole', () => {
  it('picks the highest-priority role', async () => {
    const { pickPrimaryRole } = await import('./pick-primary-role')
    expect(pickPrimaryRole(['agent', 'admin'])).toBe('admin')
    expect(pickPrimaryRole(['read_only', 'finance'])).toBe('finance')
    expect(pickPrimaryRole(['super_admin', 'admin'])).toBe('super_admin')
    expect(pickPrimaryRole([])).toBe('read_only')
  })
})
