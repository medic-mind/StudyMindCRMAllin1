// Gmail OAuth route handlers — connect + callback. ADR 0012.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getCurrentUserMock,
  oAuthStateRows,
  userRows,
  auditCalls,
  encryptFieldMock,
  setupWatchForUserMock,
  safeFetchMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn<() => Promise<unknown>>(),
  oAuthStateRows: [] as Array<{
    id: string
    userId: string
    provider: string
    state: string
    expiresAt: Date
  }>,
  userRows: [] as Array<{
    id: string
    gmailConnectionStatus: string | null
    gmailRefreshTokenCipherId: string | null
  }>,
  auditCalls: [] as Array<Record<string, unknown>>,
  encryptFieldMock: vi.fn(async () => ({
    id: 'cipher_new',
    contactId: 'u_1',
    column: 'gmail.refresh_token',
    ciphertext: Buffer.alloc(0),
    iv: Buffer.alloc(0),
    dekCiphertext: Buffer.alloc(0),
    aad: Buffer.alloc(0),
    keyVersion: 1,
  })),
  setupWatchForUserMock: vi.fn(async () => ({
    historyId: 'h_1',
    expirationMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })),
  safeFetchMock: vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(),
}))

vi.mock('@/lib/auth/server', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    oAuthState: {
      create: ({ data }: { data: (typeof oAuthStateRows)[number] }) => {
        oAuthStateRows.push(data)
        return Promise.resolve(data)
      },
      findUnique: ({ where }: { where: { state: string } }) =>
        Promise.resolve(
          oAuthStateRows.find((r) => r.state === where.state) ?? null,
        ),
      delete: ({ where }: { where: { state: string } }) => {
        const i = oAuthStateRows.findIndex((r) => r.state === where.state)
        if (i >= 0) oAuthStateRows.splice(i, 1)
        return Promise.resolve(null)
      },
    },
    user: {
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const u = userRows.find((x) => x.id === where.id)
        if (u) Object.assign(u, data)
        return Promise.resolve(u)
      },
    },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditCalls.push(data)
        return Promise.resolve({ id: 'audit_1' })
      },
    },
  },
}))

vi.mock('@studymind/audit', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@studymind/audit')
  return {
    ...actual,
    writeAuditLogEntry: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
      auditCalls.push(input)
      return 'audit_1'
    }),
  }
})

vi.mock('@studymind/core/safeguarding', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '@studymind/core/safeguarding',
  )
  return {
    ...actual,
    encryptField: encryptFieldMock,
  }
})

vi.mock('@studymind/integration-gmail/client', () => ({
  setupWatchForUser: setupWatchForUserMock,
}))

vi.mock('@studymind/core/observability/safe-fetch', () => ({
  safeFetch: (input: string | URL, init?: RequestInit) => safeFetchMock(input, init),
}))

import { GET as connectGET } from './connect/route'
import { GET as callbackGET } from './callback/route'

beforeEach(() => {
  oAuthStateRows.splice(0, oAuthStateRows.length)
  userRows.splice(0, userRows.length)
  auditCalls.splice(0, auditCalls.length)
  userRows.push({
    id: 'u_1',
    gmailConnectionStatus: null,
    gmailRefreshTokenCipherId: null,
  })
  process.env['GOOGLE_OAUTH_CLIENT_ID'] = 'test-client'
  process.env['GOOGLE_OAUTH_CLIENT_SECRET'] = 'test-secret'
  process.env['NEXT_PUBLIC_APP_URL'] = 'https://crm.test'
  vi.clearAllMocks()
  setupWatchForUserMock.mockResolvedValue({
    historyId: 'h_1',
    expirationMs: Date.now() + 7 * 24 * 60 * 60 * 1000,
  })
  encryptFieldMock.mockResolvedValue({
    id: 'cipher_new',
    contactId: 'u_1',
    column: 'gmail.refresh_token',
    ciphertext: Buffer.alloc(0),
    iv: Buffer.alloc(0),
    dekCiphertext: Buffer.alloc(0),
    aad: Buffer.alloc(0),
    keyVersion: 1,
  })
})

describe('GET /api/oauth/gmail/connect', () => {
  it('redirects unauthenticated users to /sign-in', async () => {
    getCurrentUserMock.mockResolvedValueOnce(null)
    const res = await connectGET(new Request('https://crm.test/api/oauth/gmail/connect'))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/\/sign-in/)
  })

  it('persists state and redirects to Google with correct params', async () => {
    getCurrentUserMock.mockResolvedValueOnce({ id: 'u_1', email: 'me@x', role: 'sales_executive', roles: ['sales_executive'], mustResetPassword: false })
    const res = await connectGET(new Request('https://crm.test/api/oauth/gmail/connect'))
    expect(res.status).toBe(302)
    const loc = res.headers.get('location')!
    expect(loc).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/)
    expect(loc).toContain('access_type=offline')
    expect(loc).toContain('prompt=consent')
    expect(loc).toContain('client_id=test-client')
    expect(loc).toContain(encodeURIComponent('https://crm.test/api/oauth/gmail/callback'))
    expect(oAuthStateRows).toHaveLength(1)
    expect(oAuthStateRows[0]!.userId).toBe('u_1')
    expect(oAuthStateRows[0]!.provider).toBe('gmail')
  })
})

describe('GET /api/oauth/gmail/callback', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  function authedUser() {
    getCurrentUserMock.mockResolvedValue({ id: 'u_1', email: 'me@x', role: 'sales_executive', roles: ['sales_executive'], mustResetPassword: false })
  }

  function seedState(state: string, opts: { provider?: string; expiresInMs?: number; userId?: string } = {}) {
    oAuthStateRows.push({
      id: 'os_1',
      userId: opts.userId ?? 'u_1',
      provider: opts.provider ?? 'gmail',
      state,
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 5 * 60 * 1000)),
    })
  }

  it('redirects with error= when Google reports an error', async () => {
    authedUser()
    const res = await callbackGET(
      new Request('https://crm.test/api/oauth/gmail/callback?error=access_denied'),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=access_denied')
    expect(auditCalls.some((a) => a.action === 'gmail.oauth_denied')).toBe(true)
  })

  it('rejects an unknown state', async () => {
    authedUser()
    const res = await callbackGET(
      new Request('https://crm.test/api/oauth/gmail/callback?code=xyz&state=bogus'),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=invalid_state')
    expect(auditCalls.some((a) => a.action === 'gmail.oauth_invalid_state')).toBe(true)
  })

  it('rejects an expired state', async () => {
    authedUser()
    seedState('expired-state', { expiresInMs: -1 })
    const res = await callbackGET(
      new Request('https://crm.test/api/oauth/gmail/callback?code=xyz&state=expired-state'),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=invalid_state')
    expect(oAuthStateRows).toHaveLength(0) // single-use: deleted even on reject
  })

  it('rejects when scope is missing', async () => {
    authedUser()
    seedState('s1')
    safeFetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'at',
        refresh_token: 'rt',
        scope: 'https://www.googleapis.com/auth/gmail.readonly',
      }),
    )
    const res = await callbackGET(
      new Request('https://crm.test/api/oauth/gmail/callback?code=xyz&state=s1'),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('error=scope_mismatch')
    expect(auditCalls.some((a) => a.action === 'gmail.oauth_scope_mismatch')).toBe(true)
  })

  it('happy path: encrypts, sets status, calls setupWatch, audits', async () => {
    authedUser()
    seedState('s2')
    safeFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'at',
          refresh_token: 'rt',
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ emailAddress: 'me@studymind.dev' }))
    const res = await callbackGET(
      new Request('https://crm.test/api/oauth/gmail/callback?code=xyz&state=s2'),
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('connected=1')
    expect(encryptFieldMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        ownerType: 'User',
        // Per-mailbox token key: `${userId}:${address}` (multi-account).
        ownerId: 'u_1:me@studymind.dev',
        fieldName: 'gmail.refresh_token',
        plaintext: 'rt',
      }),
    )
    expect(setupWatchForUserMock).toHaveBeenCalledWith(
      'u_1',
      expect.objectContaining({ address: 'me@studymind.dev', refreshTokenCipherId: 'cipher_new' }),
    )
    expect(userRows[0]!.gmailRefreshTokenCipherId).toBe('cipher_new')
    expect(userRows[0]!.gmailConnectionStatus).toBe('connected')
    expect(auditCalls.some((a) => a.action === 'gmail.oauth_connected')).toBe(true)
  })
})
