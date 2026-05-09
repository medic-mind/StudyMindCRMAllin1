// Gmail Pub/Sub push contract test. CLAUDE.md §14, §23.
//
// Covers:
//   1. Valid OIDC token + audience match -> 200 + ProviderEvent + Inngest.
//   2. Invalid token (verifier throws) -> 401, no DB writes.
//   3. Wrong audience (mismatched service account email) -> 401.
//   4. Replay (same body twice) -> idempotent on synthetic eventId.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { providerEventFindUnique, providerEventCreate } = vi.hoisted(() => ({
  providerEventFindUnique: vi.fn(),
  providerEventCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    providerEvent: {
      findUnique: providerEventFindUnique,
      create: providerEventCreate,
    },
  },
}))

import * as ROUTE from '@/app/api/webhooks/gmail/route'
import { setVerifier } from '../../packages/integrations/gmail/src/webhook'
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/gmail')
const AUDIENCE = 'https://crm.test/api/webhooks/gmail'
const SERVICE_ACCOUNT = 'gmail-watcher@studymind-dev.iam.gserviceaccount.com'

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
}

function buildRequest(rawBody: string, authorization: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (authorization) headers.set('authorization', authorization)
  return new Request('http://localhost/api/webhooks/gmail', {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_AUD = process.env['GMAIL_PUBSUB_AUDIENCE']
const ORIGINAL_SA = process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT']

beforeEach(() => {
  process.env['GMAIL_PUBSUB_AUDIENCE'] = AUDIENCE
  process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT'] = SERVICE_ACCOUNT
  providerEventFindUnique.mockReset()
  providerEventCreate.mockReset()
  inngestSend.mockReset()
  inngestSend.mockResolvedValue(undefined as never)
})

afterEach(() => {
  setVerifier(null)
  if (ORIGINAL_AUD === undefined) delete process.env['GMAIL_PUBSUB_AUDIENCE']
  else process.env['GMAIL_PUBSUB_AUDIENCE'] = ORIGINAL_AUD
  if (ORIGINAL_SA === undefined) delete process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT']
  else process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT'] = ORIGINAL_SA
})

describe('POST /api/webhooks/gmail — Pub/Sub push', () => {
  it('valid token + matching SA + audience -> 200, ProviderEvent, Inngest enqueue', async () => {
    setVerifier({ verify: async () => ({ email: SERVICE_ACCOUNT }) })
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gm_1' })

    const raw = loadFixture('pubsub.history-changed.json')
    const res = await ROUTE.POST(buildRequest(raw, 'Bearer fake_oidc_jwt'))
    expect(res.status).toBe(200)
    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'gmail/history.changed',
      data: expect.objectContaining({
        providerEventRowId: 'pe_gm_1',
        emailAddress: 'agent@dev.studymind',
        historyId: '9999',
      }),
    })
  })

  it('returns 401 when the JWT verifier rejects the token', async () => {
    setVerifier({
      verify: async () => {
        throw new Error('bad token')
      },
    })
    const raw = loadFixture('pubsub.history-changed.json')
    const res = await ROUTE.POST(buildRequest(raw, 'Bearer attacker_token'))
    expect(res.status).toBe(401)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 401 when the token is signed by an unexpected service account', async () => {
    setVerifier({
      verify: async () => ({ email: 'other-sa@some-project.iam.gserviceaccount.com' }),
    })
    const raw = loadFixture('pubsub.history-changed.json')
    const res = await ROUTE.POST(buildRequest(raw, 'Bearer wrong_sa_token'))
    expect(res.status).toBe(401)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('replay is idempotent on the synthetic eventId', async () => {
    setVerifier({ verify: async () => ({ email: SERVICE_ACCOUNT }) })
    const raw = loadFixture('pubsub.history-changed.json')

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gm_1' })
    const first = await ROUTE.POST(buildRequest(raw, 'Bearer fake'))
    expect(first.status).toBe(200)

    providerEventFindUnique.mockResolvedValueOnce({ id: 'pe_gm_1' })
    const second = await ROUTE.POST(buildRequest(raw, 'Bearer fake'))
    expect(second.status).toBe(200)

    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    // Both attempts still enqueue (Inngest job is itself idempotent).
    expect(inngestSend).toHaveBeenCalledTimes(2)
  })

  it('returns 500 when GMAIL_PUBSUB_AUDIENCE is not configured', async () => {
    delete process.env['GMAIL_PUBSUB_AUDIENCE']
    const raw = loadFixture('pubsub.history-changed.json')
    const res = await ROUTE.POST(buildRequest(raw, 'Bearer fake'))
    expect(res.status).toBe(500)
  })
})
