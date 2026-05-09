// Stripe webhook contract test.
// CLAUDE.md §23: webhook contract tests replay sanitised real payloads from
// __tests__/fixtures. Adding a new event handler ships with a fixture.
//
// What we cover:
//   1. Valid signature -> 200, ProviderEvent upserted, Inngest enqueued.
//   2. Replay (same body twice) -> idempotent: second call sees existing
//      ProviderEvent and does NOT create a duplicate row.
//   3. Invalid signature -> 400, no DB write, no Inngest send.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import Stripe from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the Prisma client BEFORE importing the route. The route imports
// `db` from `@/lib/db`; mocking that path avoids touching the real Prisma
// client (which would try to connect to DATABASE_URL).
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

// Static import after mocks are hoisted by vi.mock above.
import * as ROUTE from '@/app/api/webhooks/stripe/route'
// Spy on the live Inngest client. Replacing `send` keeps the test out of
// the real Inngest API while still verifying the route enqueues correctly.
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/stripe')
const WEBHOOK_SECRET = 'whsec_test_xxx_xxx_xxx'

function loadFixture(name: string): { raw: string; parsed: { id: string; type: string; created: number } } {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
  const parsed = JSON.parse(raw) as { id: string; type: string; created: number }
  return { raw, parsed }
}

function signedHeaders(rawBody: string): { header: string } {
  const stripe = new Stripe('sk_test_unused', { apiVersion: '2025-02-24.acacia' })
  const header = stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret: WEBHOOK_SECRET,
    timestamp: Math.floor(Date.now() / 1000),
  })
  return { header }
}

function buildRequest(rawBody: string, signature: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature) headers.set('stripe-signature', signature)
  return new Request('http://localhost/api/webhooks/stripe', {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_SECRET = process.env['STRIPE_WEBHOOK_SECRET']

beforeEach(() => {
  process.env['STRIPE_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  providerEventFindUnique.mockReset()
  providerEventCreate.mockReset()
  inngestSend.mockReset()
  inngestSend.mockResolvedValue(undefined as never)
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env['STRIPE_WEBHOOK_SECRET']
  else process.env['STRIPE_WEBHOOK_SECRET'] = ORIGINAL_SECRET
})

describe('POST /api/webhooks/stripe — invoice.payment_failed fixture', () => {
  it('returns 200, upserts ProviderEvent, and enqueues stripe/event.received', async () => {
    const { raw, parsed } = loadFixture('invoice.payment_failed.json')
    const { header } = signedHeaders(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_row_1' })

    const res = await ROUTE.POST(buildRequest(raw, header))

    expect(res.status).toBe(200)
    expect(providerEventFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_eventId: { provider: 'stripe', eventId: parsed.id } },
      }),
    )
    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'stripe/event.received',
      data: {
        eventId: parsed.id,
        providerEventRowId: 'pe_row_1',
        type: parsed.type,
      },
    })
  })

  it('is idempotent on replay — no duplicate ProviderEvent row', async () => {
    const { raw, parsed } = loadFixture('invoice.payment_failed.json')
    const { header } = signedHeaders(raw)

    // First delivery: not seen yet.
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_row_1' })
    const first = await ROUTE.POST(buildRequest(raw, header))
    expect(first.status).toBe(200)

    // Second delivery: ProviderEvent already exists.
    providerEventFindUnique.mockResolvedValueOnce({ id: 'pe_row_1' })
    const second = await ROUTE.POST(buildRequest(raw, header))
    expect(second.status).toBe(200)

    // create called once across both deliveries.
    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    // Inngest is enqueued on every delivery — the job itself is idempotent
    // and a Stripe retry after a previous run failed must still re-trigger.
    expect(inngestSend).toHaveBeenCalledTimes(2)
    expect(inngestSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventId: parsed.id }),
      }),
    )
  })
})

describe('POST /api/webhooks/stripe — customer.subscription.updated fixture', () => {
  it('returns 200 and forwards the right event id and type', async () => {
    const { raw, parsed } = loadFixture('customer.subscription.updated.json')
    const { header } = signedHeaders(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_row_2' })

    const res = await ROUTE.POST(buildRequest(raw, header))

    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'stripe/event.received',
      data: {
        eventId: parsed.id,
        providerEventRowId: 'pe_row_2',
        type: 'customer.subscription.updated',
      },
    })
  })
})

describe('POST /api/webhooks/stripe — invalid signature', () => {
  it('returns 400 with no DB write or Inngest send', async () => {
    const { raw } = loadFixture('invoice.payment_failed.json')
    // Wrong secret => signature mismatch.
    const stripe = new Stripe('sk_test_unused', { apiVersion: '2025-02-24.acacia' })
    const header = stripe.webhooks.generateTestHeaderString({
      payload: raw,
      secret: 'whsec_attacker_supplied',
      timestamp: Math.floor(Date.now() / 1000),
    })

    const res = await ROUTE.POST(buildRequest(raw, header))

    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 400 when the signature header is missing', async () => {
    const { raw } = loadFixture('invoice.payment_failed.json')

    const res = await ROUTE.POST(buildRequest(raw, null))

    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })
})
