// Tests for the Trengo per-agent token connect flow. CLAUDE.md §11.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@studymind/db', () => {
  return { db: makeStubDb() }
})

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: vi.fn(async () => 'audit_1'),
}))

vi.mock('@studymind/core/safeguarding', () => {
  return {
    KEY_VERSION: 1,
    // 32-byte DEK so AES-256-GCM init succeeds; opaque wrapped blob.
    generateDataKey: async () => ({
      plaintext: Buffer.alloc(32),
      ciphertext: Buffer.from([1, 2, 3, 4]),
    }),
  }
})

vi.mock('@studymind/core/observability/safe-fetch', () => ({
  safeFetch: vi.fn(),
}))

interface FakeRow {
  agentId: string
  tokenCiphertext: Buffer
  tokenIv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
  expiresAt: Date
  deletedAt: Date | null
}

const ROWS: FakeRow[] = []

function makeStubDb() {
  return {
    trengoToken: {
      upsert: vi.fn(async (args: { where: { agentId: string }; create: FakeRow; update: Partial<FakeRow> }) => {
        const existing = ROWS.find((r) => r.agentId === args.where.agentId)
        if (existing) {
          Object.assign(existing, args.update)
          return existing
        }
        const row: FakeRow = { ...args.create, deletedAt: args.create.deletedAt ?? null }
        ROWS.push(row)
        return row
      }),
    },
    // Phase 6: connect now stamps User.trengoUserId from `/me`. The stub
    // accepts the update and records it on a side map so tests can assert
    // the mapping when relevant.
    user: {
      update: vi.fn(async (args: { where: { id: string }; data: { trengoUserId?: number } }) => {
        return { id: args.where.id, trengoUserId: args.data.trengoUserId ?? null }
      }),
    },
    auditLogEntry: { create: vi.fn(), findFirst: vi.fn() },
  }
}

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import { connectTrengoToken, TrengoTokenInvalidError, TRENGO_TOKEN_LIFETIME_MS } from './connect'

const fetchMock = vi.mocked(safeFetch)

beforeEach(() => {
  ROWS.length = 0
  fetchMock.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

function mockTrengoMe(status: number, body: unknown = {}) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status }) as never,
  )
}

describe('connectTrengoToken', () => {
  it('rejects an invalid token without writing anything', async () => {
    mockTrengoMe(401)
    await expect(
      connectTrengoToken({
        agentId: 'u_1',
        token: 'bad-token-1234',
        requestId: 'req_1',
      }),
    ).rejects.toBeInstanceOf(TrengoTokenInvalidError)
    expect(ROWS).toHaveLength(0)
  })

  it('encrypts and persists a valid token with a 90-day expiry', async () => {
    mockTrengoMe(200, { data: { id: 42, email: 'agent@example.com' } })
    const before = Date.now()
    const result = await connectTrengoToken({
      agentId: 'u_2',
      token: 'tok_valid_abc123',
      requestId: 'req_2',
    })
    const after = Date.now()

    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TRENGO_TOKEN_LIFETIME_MS - 1000)
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + TRENGO_TOKEN_LIFETIME_MS + 1000)
    expect(result.trengoEmail).toBe('agent@example.com')
    expect(ROWS).toHaveLength(1)
    expect(ROWS[0]?.agentId).toBe('u_2')
    expect(ROWS[0]?.tokenCiphertext.length).toBeGreaterThan(0)
    expect(ROWS[0]?.tokenCiphertext.toString('utf8')).not.toContain('tok_valid_abc123')
    expect(ROWS[0]?.aad.toString('utf8')).toBe('User|u_2|trengo.api_token|1')
  })

  it('stamps User.trengoUserId from /me on connect (Phase 6 mapping)', async () => {
    mockTrengoMe(200, { data: { id: 555, email: 'agent@example.com' } })
    const { db } = await import('@studymind/db')
    const userUpdate = vi.mocked(db.user.update)
    userUpdate.mockClear()
    await connectTrengoToken({
      agentId: 'u_phase6',
      token: 'tok_phase6_abc',
      requestId: 'req_phase6',
    })
    expect(userUpdate).toHaveBeenCalledTimes(1)
    expect(userUpdate.mock.calls[0]?.[0]).toEqual({
      where: { id: 'u_phase6' },
      data: { trengoUserId: 555 },
    })
  })

  it('skips the User.trengoUserId stamp when /me omits the id', async () => {
    mockTrengoMe(200, {})
    const { db } = await import('@studymind/db')
    const userUpdate = vi.mocked(db.user.update)
    userUpdate.mockClear()
    await connectTrengoToken({
      agentId: 'u_no_id',
      token: 'tok_no_id_xyz',
      requestId: 'req_no_id',
    })
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('overwrites the existing row on reconnect (deletedAt cleared)', async () => {
    ROWS.push({
      agentId: 'u_3',
      tokenCiphertext: Buffer.from('old'),
      tokenIv: Buffer.alloc(12),
      dekCiphertext: Buffer.from([0]),
      aad: Buffer.from('User|u_3|trengo.api_token|1'),
      keyVersion: 1,
      expiresAt: new Date(Date.now() - 60_000),
      deletedAt: new Date(Date.now() - 60_000),
    })
    mockTrengoMe(200, { data: { id: 7 } })
    await connectTrengoToken({
      agentId: 'u_3',
      token: 'tok_replace_xyz',
      requestId: 'req_3',
    })
    expect(ROWS).toHaveLength(1)
    expect(ROWS[0]?.deletedAt).toBeNull()
    expect(ROWS[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now())
  })
})
