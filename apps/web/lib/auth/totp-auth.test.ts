// Tests for the TOTP-aware sign-in flow and the privileged-role enrolment
// gate. Like auth.test.ts we re-implement the authorize() callback in-line
// so we exercise the decision tree without booting NextAuth.
//
// CLAUDE.md §20.

import { authenticator } from 'otplib'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '@studymind/core/auth/passwords'

import { generateRecoveryCodes, generateTotpSecret } from './totp'

interface UserRow {
  id: string
  email: string
  name: string | null
  passwordHash: string | null
  emailVerifiedAt: Date | null
  mustResetPassword: boolean
  failedSignInAttempts: number
  lockedUntil: Date | null
  deactivatedAt: Date | null
  totpEnabledAt: Date | null
  totpSecretCipherId: string | null
}

interface AuthorizeInput {
  email: string
  password: string
  totpCode?: string
  recoveryCode?: string
}

const recoveryStore: { userId: string; codeHash: string; usedAt: Date | null }[] = []
const auditCalls: { action: string; actorId: string | null }[] = []
const userStore: { rows: Map<string, UserRow> } = { rows: new Map() }

const mockedDb = {
  user: {
    findUnique: vi.fn(async (args: { where: { email?: string; id?: string } }) => {
      if (args.where.email) {
        for (const u of userStore.rows.values()) {
          if (u.email === args.where.email) return u
        }
        return null
      }
      if (args.where.id) return userStore.rows.get(args.where.id) ?? null
      return null
    }),
    update: vi.fn(async () => ({})),
  },
  totpRecoveryCode: {
    updateMany: vi.fn(
      async (args: {
        where: { userId: string; codeHash: string; usedAt: null }
        data: { usedAt: Date }
      }) => {
        const row = recoveryStore.find(
          (r) =>
            r.userId === args.where.userId &&
            r.codeHash === args.where.codeHash &&
            r.usedAt === null,
        )
        if (!row) return { count: 0 }
        row.usedAt = args.data.usedAt
        return { count: 1 }
      },
    ),
  },
  encryptedField: {
    findUniqueOrThrow: vi.fn(),
  },
  auditLogEntry: {
    create: vi.fn(async (args: { data: { action: string; actorId: string | null } }) => {
      auditCalls.push({ action: args.data.action, actorId: args.data.actorId })
      return args.data
    }),
    findFirst: vi.fn(async () => null),
  },
}

vi.mock('@studymind/db', () => ({ db: mockedDb }))

// Stub out KMS-backed decrypt — return whatever ciphertext was registered
// against the EncryptedField id for the test.
const fakeSecrets = new Map<string, string>()
vi.mock('@studymind/core/safeguarding', () => ({
  decryptFieldById: vi.fn(async (_db: unknown, input: { encryptedFieldId: string }) => {
    const v = fakeSecrets.get(input.encryptedFieldId)
    if (!v) throw new Error('no test secret')
    return v
  }),
}))

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: vi.fn(
    async (
      _db: unknown,
      input: { actorId: string | null; action: string },
    ) => {
      auditCalls.push({ action: input.action, actorId: input.actorId })
      return 'audit_1'
    },
  ),
}))

async function authorize(
  input: AuthorizeInput,
): Promise<{ id: string; totpEnabledAt: string | null }> {
  const { assertNotLocked, recordFailedAttempt, recordSuccessfulSignIn } =
    await import('@studymind/core/auth/lockout')
  const { verifyPassword } = await import('@studymind/core/auth/passwords')
  const { BusinessError } = await import('@studymind/core/errors')
  const { decryptFieldById } = await import('@studymind/core/safeguarding')
  const { writeAuditLogEntry } = await import('@studymind/audit')
  const { verifyRecoveryCode, verifyTotpCode } = await import('./totp')

  const user = await mockedDb.user.findUnique({
    where: { email: input.email.toLowerCase() },
  })
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
  const ok = await verifyPassword(input.password, user.passwordHash)
  if (!ok) {
    await recordFailedAttempt(user, mockedDb as never)
    throw new Error('INVALID_CREDENTIALS')
  }
  if (!user.emailVerifiedAt) throw new Error('EMAIL_NOT_VERIFIED')

  if (user.totpEnabledAt && user.totpSecretCipherId) {
    if (!input.totpCode && !input.recoveryCode) {
      throw new Error('TOTP_REQUIRED')
    }
    let factorOk = false
    if (input.totpCode) {
      const secret = await decryptFieldById(mockedDb as never, {
        encryptedFieldId: user.totpSecretCipherId,
        actorId: user.id,
        purpose: 'auth.totp_verify',
      })
      factorOk = verifyTotpCode({ secret, code: input.totpCode })
      if (!factorOk) {
        await writeAuditLogEntry(mockedDb as never, {
          actorId: user.id,
          action: 'auth.totp_failed',
          target: { type: 'User', id: user.id },
        })
      }
    }
    if (!factorOk && input.recoveryCode) {
      factorOk = await verifyRecoveryCode({
        db: mockedDb as never,
        userId: user.id,
        code: input.recoveryCode,
      })
      if (factorOk) {
        await writeAuditLogEntry(mockedDb as never, {
          actorId: user.id,
          action: 'auth.recovery_code_used',
          target: { type: 'User', id: user.id },
        })
      }
    }
    if (!factorOk) {
      await recordFailedAttempt(user, mockedDb as never)
      throw new Error('INVALID_CREDENTIALS')
    }
  }

  await recordSuccessfulSignIn(user, mockedDb as never, { ip: null, ua: null })
  return {
    id: user.id,
    totpEnabledAt: user.totpEnabledAt ? user.totpEnabledAt.toISOString() : null,
  }
}

async function seedUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  const passwordHash = await hashPassword('Strong-Pass-1')
  const row: UserRow = {
    id: 'u_1',
    email: 'agent@dev.studymind',
    name: 'Test',
    passwordHash,
    emailVerifiedAt: new Date(),
    mustResetPassword: false,
    failedSignInAttempts: 0,
    lockedUntil: null,
    deactivatedAt: null,
    totpEnabledAt: null,
    totpSecretCipherId: null,
    ...overrides,
  }
  userStore.rows.set(row.id, row)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  userStore.rows.clear()
  recoveryStore.length = 0
  fakeSecrets.clear()
  auditCalls.length = 0
})

describe('authorize: TOTP gate', () => {
  it('throws TOTP_REQUIRED when MFA is enabled and no code is supplied', async () => {
    await seedUser({
      totpEnabledAt: new Date(),
      totpSecretCipherId: 'ef_1',
    })
    fakeSecrets.set('ef_1', generateTotpSecret().base32)
    await expect(
      authorize({ email: 'agent@dev.studymind', password: 'Strong-Pass-1' }),
    ).rejects.toThrow('TOTP_REQUIRED')
  })

  it('rejects a wrong TOTP code with INVALID_CREDENTIALS and audits', async () => {
    await seedUser({
      totpEnabledAt: new Date(),
      totpSecretCipherId: 'ef_1',
    })
    const { base32 } = generateTotpSecret()
    fakeSecrets.set('ef_1', base32)
    await expect(
      authorize({
        email: 'agent@dev.studymind',
        password: 'Strong-Pass-1',
        totpCode: '000000',
      }),
    ).rejects.toThrow('INVALID_CREDENTIALS')
    expect(auditCalls.some((c) => c.action === 'auth.totp_failed')).toBe(true)
  })

  it('accepts a correct TOTP code and signs the user in', async () => {
    const u = await seedUser({
      totpEnabledAt: new Date(),
      totpSecretCipherId: 'ef_1',
    })
    const { base32 } = generateTotpSecret()
    fakeSecrets.set('ef_1', base32)
    const code = authenticator.generate(base32)
    const result = await authorize({
      email: 'agent@dev.studymind',
      password: 'Strong-Pass-1',
      totpCode: code,
    })
    expect(result.id).toBe(u.id)
    expect(result.totpEnabledAt).not.toBeNull()
    expect(auditCalls.some((c) => c.action === 'auth.totp_failed')).toBe(false)
  })

  it('accepts a recovery code, marks it used, and audits recovery_code_used', async () => {
    await seedUser({
      totpEnabledAt: new Date(),
      totpSecretCipherId: 'ef_1',
    })
    fakeSecrets.set('ef_1', generateTotpSecret().base32)
    const { plain, hashes } = generateRecoveryCodes()
    for (const codeHash of hashes) {
      recoveryStore.push({ userId: 'u_1', codeHash, usedAt: null })
    }
    const recoveryCode = plain[0]!
    await authorize({
      email: 'agent@dev.studymind',
      password: 'Strong-Pass-1',
      recoveryCode,
    })
    expect(auditCalls.some((c) => c.action === 'auth.recovery_code_used')).toBe(true)
    // Replay rejected.
    await expect(
      authorize({
        email: 'agent@dev.studymind',
        password: 'Strong-Pass-1',
        recoveryCode,
      }),
    ).rejects.toThrow('INVALID_CREDENTIALS')
  })

  it('does not require TOTP when MFA is not enabled', async () => {
    const u = await seedUser({})
    const result = await authorize({
      email: 'agent@dev.studymind',
      password: 'Strong-Pass-1',
    })
    expect(result.id).toBe(u.id)
  })
})

describe('mandatory MFA enrolment gate (middleware logic)', () => {
  // The middleware function is hard to import in a node test (it depends on
  // next/server). We mirror its decision predicate here so the rule is
  // pinned by tests.
  function shouldRedirectToSetup(args: {
    pathname: string
    user: { totpEnabledAt: string | null; roles?: string[]; role?: string } | null
  }): boolean {
    if (!args.user) return false
    if (args.user.totpEnabledAt) return false
    const PRIVILEGED = new Set(['super_admin', 'admin', 'finance', 'dsl'])
    const isPriv =
      (args.user.roles ?? []).some((r) => PRIVILEGED.has(r)) ||
      (args.user.role ? PRIVILEGED.has(args.user.role) : false)
    if (!isPriv) return false
    if (args.pathname === '/account/setup-2fa') return false
    if (args.pathname === '/account/change-password') return false
    if (args.pathname.startsWith('/api/auth/')) return false
    if (args.pathname === '/api/health') return false
    return true
  }

  it('redirects an admin without TOTP to /account/setup-2fa', () => {
    expect(
      shouldRedirectToSetup({
        pathname: '/inbox',
        user: { totpEnabledAt: null, roles: ['admin'] },
      }),
    ).toBe(true)
  })

  it('does not redirect an agent (non-privileged) without TOTP', () => {
    expect(
      shouldRedirectToSetup({
        pathname: '/inbox',
        user: { totpEnabledAt: null, roles: ['agent'] },
      }),
    ).toBe(false)
  })

  it('does not redirect a finance user that has TOTP enabled', () => {
    expect(
      shouldRedirectToSetup({
        pathname: '/inbox',
        user: { totpEnabledAt: '2026-01-01T00:00:00Z', roles: ['finance'] },
      }),
    ).toBe(false)
  })

  it('exempts the setup page itself so the user can complete enrolment', () => {
    expect(
      shouldRedirectToSetup({
        pathname: '/account/setup-2fa',
        user: { totpEnabledAt: null, roles: ['dsl'] },
      }),
    ).toBe(false)
  })

  it('exempts /api/auth/signout and /api/health', () => {
    expect(
      shouldRedirectToSetup({
        pathname: '/api/auth/signout',
        user: { totpEnabledAt: null, roles: ['admin'] },
      }),
    ).toBe(false)
    expect(
      shouldRedirectToSetup({
        pathname: '/api/health',
        user: { totpEnabledAt: null, roles: ['admin'] },
      }),
    ).toBe(false)
  })
})
