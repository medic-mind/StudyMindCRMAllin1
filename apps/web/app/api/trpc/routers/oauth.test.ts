// OAuth router tests. ADR 0012.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@studymind/core/safeguarding', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@studymind/core/safeguarding',
  )
  return {
    ...actual,
    decryptFieldById: vi.fn(async () => 'rt_secret'),
  }
})

vi.mock('@studymind/core/observability/safe-fetch', () => ({
  safeFetch: vi.fn(async () => ({ ok: true, status: 200 })),
}))

vi.mock('@studymind/integration-gmail/client', () => ({
  stopWatchForUser: vi.fn(async () => undefined),
}))

import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { decryptFieldById } from '@studymind/core/safeguarding'
import { stopWatchForUser } from '@studymind/integration-gmail/client'

import type {
  AuditRecorder,
  SessionUser,
  TrpcContext,
} from '@/lib/trpc/builders'

import { oauthRouter } from './oauth'

interface UserRow {
  id: string
  gmailConnectionStatus: string | null
  gmailRefreshTokenCipherId: string | null
}
interface MailboxRow {
  agentId: string
  address: string
  historyId: string | null
  watchExpiresAt: Date | null
  deletedAt: Date | null
}
interface CipherRow {
  id: string
}

function makeCtx(opts: {
  user?: UserRow
  mailbox?: MailboxRow | null
  ciphers?: CipherRow[]
}): {
  ctx: TrpcContext
  users: UserRow[]
  ciphers: CipherRow[]
  audit: ReturnType<typeof vi.fn>
} {
  const users: UserRow[] = [
    opts.user ?? {
      id: 'u_1',
      gmailConnectionStatus: 'connected',
      gmailRefreshTokenCipherId: 'cipher_1',
    },
  ]
  const ciphers: CipherRow[] = opts.ciphers ?? [{ id: 'cipher_1' }]
  const mailbox = opts.mailbox === undefined ? {
    agentId: 'u_1',
    address: 'me@studymind.dev',
    historyId: '12345',
    watchExpiresAt: new Date('2026-05-17T00:00:00Z'),
    deletedAt: null,
  } : opts.mailbox

  const audit = vi.fn(async (_i: unknown) => 'audit_1')
  const recorder: AuditRecorder = (async (input) => {
    ;(recorder as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(recorder as unknown as { called: boolean }).called = false

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
    gmailMailbox: {
      findUnique: ({ where }: { where: { agentId: string } }) =>
        Promise.resolve(
          mailbox && mailbox.agentId === where.agentId ? mailbox : null,
        ),
      findFirst: ({ where }: { where: { agentId: string } }) =>
        Promise.resolve(
          mailbox && mailbox.agentId === where.agentId ? mailbox : null,
        ),
    },
    encryptedField: {
      deleteMany: ({ where }: { where: { id: string } }) => {
        const idx = ciphers.findIndex((c) => c.id === where.id)
        if (idx >= 0) ciphers.splice(idx, 1)
        return Promise.resolve({ count: idx >= 0 ? 1 : 0 })
      },
    },
    $transaction: async (ops: Array<Promise<unknown>>) => Promise.all(ops),
  }

  const sessionUser: SessionUser = {
    id: 'u_1',
    email: 'me@studymind.dev',
    role: 'sales_executive',
    mustResetPassword: false,
    sessionId: 'sess_1',
  }
  const ctx: TrpcContext = {
    user: sessionUser,
    requestId: 'req_1',
    db: db as never,
    audit: recorder,
    headers: { origin: null, host: null },
  }
  return { ctx, users, ciphers, audit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('oauth.gmail.status', () => {
  it('returns connected status with mailbox details', async () => {
    const { ctx } = makeCtx({})
    const caller = oauthRouter.createCaller(ctx)
    const r = await caller.gmail.status()
    expect(r.connected).toBe(true)
    expect(r.address).toBe('me@studymind.dev')
    expect(r.historyId).toBe('12345')
  })

  it('returns disconnected when no cipher pointer', async () => {
    const { ctx } = makeCtx({
      user: {
        id: 'u_1',
        gmailConnectionStatus: 'disconnected',
        gmailRefreshTokenCipherId: null,
      },
      mailbox: null,
    })
    const caller = oauthRouter.createCaller(ctx)
    const r = await caller.gmail.status()
    expect(r.connected).toBe(false)
    expect(r.address).toBeNull()
  })
})

describe('oauth.gmail.disconnect', () => {
  it('revokes at Google, stops watch, deletes cipher, audits', async () => {
    const { ctx, users, ciphers, audit } = makeCtx({})
    const caller = oauthRouter.createCaller(ctx)
    const r = await caller.gmail.disconnect()
    expect(r.ok).toBe(true)
    expect(decryptFieldById).toHaveBeenCalled()
    expect(safeFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/revoke',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(stopWatchForUser).toHaveBeenCalledWith('u_1')
    expect(ciphers).toHaveLength(0)
    expect(users[0]!.gmailConnectionStatus).toBe('disconnected')
    expect(users[0]!.gmailRefreshTokenCipherId).toBeNull()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'gmail.oauth_disconnected' }),
    )
  })

  it('throws NOT_FOUND if no connection', async () => {
    const { ctx } = makeCtx({
      user: {
        id: 'u_1',
        gmailConnectionStatus: 'disconnected',
        gmailRefreshTokenCipherId: null,
      },
      mailbox: null,
      ciphers: [],
    })
    const caller = oauthRouter.createCaller(ctx)
    await expect(caller.gmail.disconnect()).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('proceeds even when revoke at Google fails', async () => {
    const sf = safeFetch as unknown as ReturnType<typeof vi.fn>
    sf.mockRejectedValueOnce(new Error('network down'))
    const { ctx, ciphers, users } = makeCtx({})
    const caller = oauthRouter.createCaller(ctx)
    const r = await caller.gmail.disconnect()
    expect(r.ok).toBe(true)
    expect(ciphers).toHaveLength(0)
    expect(users[0]!.gmailConnectionStatus).toBe('disconnected')
  })
})
