// Account router tests. ADR 0010, chunk 7.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashPassword } from '@studymind/core/auth/passwords'

import type {
  AuditRecorder,
  SessionUser,
  TrpcContext,
} from '@/lib/trpc/builders'

import { accountRouter } from './account'

interface UserRow {
  id: string
  email: string
  name: string | null
  passwordHash: string | null
  emailVerifiedAt: Date | null
  failedSignInAttempts: number
  lockedUntil: Date | null
  mustResetPassword: boolean
  lastSignInAt: Date | null
}

interface SessionRow {
  id: string
  userId: string
  createdAt: Date
  expiresAt: Date
  ipAddress: string | null
  userAgent: string | null
}

async function makeCtx(opts: {
  userId?: string
  sessionId?: string
  password?: string
  mustResetPassword?: boolean
  sessions?: SessionRow[]
}): Promise<{
  ctx: TrpcContext
  users: UserRow[]
  sessions: SessionRow[]
  audit: ReturnType<typeof vi.fn>
}> {
  const userId = opts.userId ?? 'u_1'
  const passwordHash = opts.password
    ? await hashPassword(opts.password)
    : await hashPassword('CorrectHorse-Battery-1')

  const users: UserRow[] = [
    {
      id: userId,
      email: 'me@example.com',
      name: 'Me',
      passwordHash,
      emailVerifiedAt: new Date(),
      failedSignInAttempts: 0,
      lockedUntil: null,
      mustResetPassword: opts.mustResetPassword ?? false,
      lastSignInAt: new Date('2026-01-01T10:00:00Z'),
    },
  ]
  const sessions: SessionRow[] =
    opts.sessions ??
    [
      {
        id: 'sess_current',
        userId,
        createdAt: new Date('2026-05-01T10:00:00Z'),
        expiresAt: new Date('2026-05-01T22:00:00Z'),
        ipAddress: '1.2.3.4',
        userAgent: 'Chrome',
      },
      {
        id: 'sess_other',
        userId,
        createdAt: new Date('2026-05-02T10:00:00Z'),
        expiresAt: new Date('2026-05-02T22:00:00Z'),
        ipAddress: '5.6.7.8',
        userAgent: 'Firefox',
      },
    ]

  const audit = vi.fn(async (_input: unknown) => 'audit_1')
  const wrapped: AuditRecorder = (async (input) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const db = {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(users.find((u) => u.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const u = users.find((x) => x.id === where.id)
        if (!u) throw new Error('not found')
        Object.assign(u, data)
        return Promise.resolve(u)
      },
    },
    session: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(sessions.find((s) => s.id === where.id) ?? null),
      findMany: ({ where }: { where: { userId: string } }) =>
        Promise.resolve(
          sessions
            .filter((s) => s.userId === where.userId)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
        ),
      delete: ({ where }: { where: { id: string } }) => {
        const idx = sessions.findIndex((s) => s.id === where.id)
        if (idx >= 0) sessions.splice(idx, 1)
        return Promise.resolve({ id: where.id })
      },
      deleteMany: ({
        where,
      }: {
        where: { userId: string; NOT?: { id: string } }
      }) => {
        let count = 0
        for (let i = sessions.length - 1; i >= 0; i--) {
          const s = sessions[i]!
          if (s.userId !== where.userId) continue
          if (where.NOT?.id && s.id === where.NOT.id) continue
          sessions.splice(i, 1)
          count++
        }
        return Promise.resolve({ count })
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  }

  const user: SessionUser = {
    id: userId,
    email: 'me@example.com',
    role: 'agent',
    mustResetPassword: opts.mustResetPassword ?? false,
    sessionId: opts.sessionId ?? 'sess_current',
  }
  const ctx: TrpcContext = {
    user,
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, users, sessions, audit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('account.changePassword', () => {
  it('rotates the password and revokes other sessions', async () => {
    const { ctx, users, sessions, audit } = await makeCtx({
      password: 'CorrectHorse-Battery-1',
    })
    const caller = accountRouter.createCaller(ctx)
    const r = await caller.changePassword({
      currentPassword: 'CorrectHorse-Battery-1',
      newPassword: 'BrandNew-Battery-9',
    })
    expect(r.ok).toBe(true)
    expect(users[0]!.mustResetPassword).toBe(false)
    expect(users[0]!.passwordHash).not.toBe(
      await hashPassword('CorrectHorse-Battery-1'),
    )
    // Current session preserved, the other one is gone.
    expect(sessions.map((s) => s.id)).toEqual(['sess_current'])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.password_changed' }),
    )
  })

  it('rejects a wrong current password', async () => {
    const { ctx } = await makeCtx({ password: 'Right-Original-1' })
    const caller = accountRouter.createCaller(ctx)
    await expect(
      caller.changePassword({
        currentPassword: 'Wrong-Original-1',
        newPassword: 'Brand-New-Strong-9',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('enforces password strength', async () => {
    const { ctx } = await makeCtx({ password: 'CorrectHorse-Battery-1' })
    const caller = accountRouter.createCaller(ctx)
    await expect(
      caller.changePassword({
        currentPassword: 'CorrectHorse-Battery-1',
        newPassword: 'short',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('clears mustResetPassword on success', async () => {
    const { ctx, users } = await makeCtx({
      password: 'CorrectHorse-Battery-1',
      mustResetPassword: true,
    })
    const caller = accountRouter.createCaller(ctx)
    await caller.changePassword({
      currentPassword: 'CorrectHorse-Battery-1',
      newPassword: 'BrandNew-Battery-9',
    })
    expect(users[0]!.mustResetPassword).toBe(false)
  })
})

describe('account.sessions', () => {
  it('list returns only the calling user sessions', async () => {
    const { ctx } = await makeCtx({})
    const caller = accountRouter.createCaller(ctx)
    const out = await caller.sessions.list()
    expect(out.items).toHaveLength(2)
    expect(out.items.find((s) => s.id === 'sess_current')?.isCurrent).toBe(true)
  })

  it('revoke fails for sessions you do not own', async () => {
    const { ctx, sessions } = await makeCtx({})
    sessions.push({
      id: 'sess_alien',
      userId: 'u_other',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1_000_000),
      ipAddress: null,
      userAgent: null,
    })
    const caller = accountRouter.createCaller(ctx)
    await expect(
      caller.sessions.revoke({ sessionId: 'sess_alien' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('revoke deletes a single owned session and audits', async () => {
    const { ctx, sessions, audit } = await makeCtx({})
    const caller = accountRouter.createCaller(ctx)
    await caller.sessions.revoke({ sessionId: 'sess_other' })
    expect(sessions.find((s) => s.id === 'sess_other')).toBeUndefined()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.session_revoked' }),
    )
  })

  it('revokeAllOthers deletes everything except the current session', async () => {
    const { ctx, sessions } = await makeCtx({})
    sessions.push({
      id: 'sess_third',
      userId: 'u_1',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 1_000_000),
      ipAddress: null,
      userAgent: null,
    })
    const caller = accountRouter.createCaller(ctx)
    const r = await caller.sessions.revokeAllOthers()
    expect(r.count).toBe(2)
    expect(sessions.map((s) => s.id)).toEqual(['sess_current'])
  })
})
