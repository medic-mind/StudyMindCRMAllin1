// Contract tests for the lead webhook. CLAUDE.md §16, §23.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  leads,
  interactions,
  audits,
  leadFindFirst,
  txLeadCreate,
  txInteractionCreate,
} = vi.hoisted(() => {
  const leads: Array<{ id: string; source: string; name: string }> = []
  const interactions: Array<{ id: string }> = []
  const audits: Array<{ action: string; targetId: string }> = []
  return {
    leads,
    interactions,
    audits,
    leadFindFirst: vi.fn(({ where }: { where: { source: string; name: string } }) => {
      const m = leads.find((l) => l.source === where.source && l.name === where.name)
      return Promise.resolve(m ?? null)
    }),
    txLeadCreate: vi.fn(({ data }: { data: { id: string; source: string; name: string } }) => {
      leads.push({ id: data.id, source: data.source, name: data.name })
      return Promise.resolve({ id: data.id })
    }),
    txInteractionCreate: vi.fn(({ data }: { data: { id: string } }) => {
      interactions.push({ id: data.id })
      return Promise.resolve({ id: data.id })
    }),
  }
})

vi.mock('@/lib/db', () => ({
  db: {
    lead: { findFirst: leadFindFirst },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: { id: string; action: string; targetId: string } }) => {
        audits.push({ action: data.action, targetId: data.targetId })
        return Promise.resolve({ id: data.id })
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        lead: { create: txLeadCreate },
        interaction: { create: txInteractionCreate },
      }),
  },
}))

vi.mock('@studymind/core/observability/sentry', () => ({
  withSentry: <T>(fn: T) => fn,
}))

import { POST, leadIdempotencyKey } from '@/app/api/webhooks/lead/route'

const BEARER = 'test-token-1234'

beforeEach(() => {
  process.env['LEAD_WEBHOOK_TOKEN'] = BEARER
  delete process.env['LEAD_WEBHOOK_BEARER_TOKEN']
  leads.length = 0
  interactions.length = 0
  audits.length = 0
  leadFindFirst.mockClear()
  txLeadCreate.mockClear()
  txInteractionCreate.mockClear()
})

afterEach(() => {
  delete process.env['LEAD_WEBHOOK_TOKEN']
})

function makeReq(body: unknown, opts: { auth?: string | null } = {}): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (opts.auth !== null) {
    headers.set('authorization', opts.auth ?? `Bearer ${BEARER}`)
  }
  return new Request('http://localhost/api/webhooks/lead', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

describe('lead webhook', () => {
  it('rejects when the bearer is missing', async () => {
    const r = await POST(makeReq({ source: 'z' }, { auth: null }))
    expect(r.status).toBe(401)
  })

  it('rejects an incorrect bearer with constant-time compare', async () => {
    const r = await POST(makeReq({ source: 'z' }, { auth: 'Bearer wrong' }))
    expect(r.status).toBe(401)
  })

  it('returns 503 when the token env is missing', async () => {
    delete process.env['LEAD_WEBHOOK_TOKEN']
    const r = await POST(makeReq({ source: 'z' }))
    expect(r.status).toBe(503)
  })

  it('rejects schema violations with 400', async () => {
    const r = await POST(makeReq({ email: 'not-an-email' }))
    expect(r.status).toBe(400)
  })

  it('accepts a well-formed lead and persists Lead + Interaction + audit', async () => {
    const r = await POST(
      makeReq({
        source: 'zapier:fb',
        email: 'p@example.com',
        notes: 'asked about EHCP',
        ehcp: true,
      }),
    )
    expect(r.status).toBe(200)
    const j = (await r.json()) as { ok: boolean; id: string }
    expect(j.ok).toBe(true)
    expect(leads).toHaveLength(1)
    expect(interactions).toHaveLength(1)
    expect(audits[0]?.action).toBe('lead.received')
  })

  it('dedupes Zapier retries on the (source, ident, notes-hash) key', async () => {
    const body = {
      source: 'zapier:fb',
      email: 'p@example.com',
      notes: 'hello',
    }
    const a = await POST(makeReq(body))
    expect(a.status).toBe(200)
    expect(leads).toHaveLength(1)
    const b = await POST(makeReq(body))
    expect(b.status).toBe(200)
    const j = (await b.json()) as { ok: boolean; deduped: boolean; id: string }
    expect(j.deduped).toBe(true)
    expect(leads).toHaveLength(1)
  })

  it('does NOT dedupe when notes differ — same email, different content', async () => {
    const a = await POST(
      makeReq({ source: 'zapier:fb', email: 'p@example.com', notes: 'first' }),
    )
    expect(a.status).toBe(200)
    const b = await POST(
      makeReq({ source: 'zapier:fb', email: 'p@example.com', notes: 'second' }),
    )
    expect(b.status).toBe(200)
    expect(leads).toHaveLength(2)
  })

  it('idempotency key is stable for the same logical input', () => {
    const k1 = leadIdempotencyKey({ source: 's', email: 'A@B.C', notes: 'n' })
    const k2 = leadIdempotencyKey({ source: 's', email: 'a@b.c', notes: 'n' })
    expect(k1).toBe(k2)
  })
})
