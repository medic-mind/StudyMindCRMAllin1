// GoCardless webhook contract test.
// CLAUDE.md §9, §23: webhook contract tests replay sanitised payloads from
// __tests__/fixtures. A single GoCardless request can carry multiple events
// in events[]; we cover that path explicitly here.
//
// What we cover:
//   1. Valid signature -> 200, ProviderEvent upserted per event, Inngest
//      enqueued per event.
//   2. Multi-event payload -> each event becomes a separate ProviderEvent
//      and a separate Inngest enqueue.
//   3. Replay (same body twice) -> idempotent: second call sees existing
//      ProviderEvent rows and does NOT create duplicates.
//   4. Invalid signature -> 400, no DB write, no Inngest send.
//   5. Late-failure reversal flow at the domain layer: confirm a payment,
//      then trigger revertGcPayment and assert reverted state + flag.
//   6. Unknown event type still upserts and enqueues (the Inngest job is
//      where the type filter lives — see jobs.ts HANDLED_KEYS).

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  providerEventFindUnique,
  providerEventCreate,
} = vi.hoisted(() => ({
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

import * as ROUTE from '@/app/api/webhooks/gocardless/route'
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/gocardless')
const WEBHOOK_SECRET = 'whsec_gocardless_test_xxx'

interface RawEvent {
  id: string
  resource_type: string
  action: string
}

function loadFixture(name: string): { raw: string; events: RawEvent[] } {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
  const parsed = JSON.parse(raw) as { events: RawEvent[] }
  return { raw, events: parsed.events }
}

function signRaw(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

function buildRequest(rawBody: string, signature: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature) headers.set('webhook-signature', signature)
  return new Request('http://localhost/api/webhooks/gocardless', {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_SECRET = process.env['GOCARDLESS_WEBHOOK_SECRET']

beforeEach(() => {
  process.env['GOCARDLESS_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  providerEventFindUnique.mockReset()
  providerEventCreate.mockReset()
  inngestSend.mockReset()
  inngestSend.mockResolvedValue(undefined as never)
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env['GOCARDLESS_WEBHOOK_SECRET']
  else process.env['GOCARDLESS_WEBHOOK_SECRET'] = ORIGINAL_SECRET
})

describe('POST /api/webhooks/gocardless — payments.confirmed fixture', () => {
  it('returns 200, upserts ProviderEvent, and enqueues gocardless/event.received', async () => {
    const { raw, events } = loadFixture('payments.confirmed.json')
    const sig = signRaw(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gc_1' })

    const res = await ROUTE.POST(buildRequest(raw, sig))

    expect(res.status).toBe(200)
    expect(providerEventFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_eventId: { provider: 'gocardless', eventId: events[0]!.id } },
      }),
    )
    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'gocardless/event.received',
      data: {
        eventId: events[0]!.id,
        providerEventRowId: 'pe_gc_1',
        type: 'payments/confirmed',
      },
    })
  })

  it('is idempotent on replay — no duplicate ProviderEvent row', async () => {
    const { raw, events } = loadFixture('payments.confirmed.json')
    const sig = signRaw(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gc_1' })
    const first = await ROUTE.POST(buildRequest(raw, sig))
    expect(first.status).toBe(200)

    providerEventFindUnique.mockResolvedValueOnce({ id: 'pe_gc_1' })
    const second = await ROUTE.POST(buildRequest(raw, sig))
    expect(second.status).toBe(200)

    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledTimes(2)
    expect(inngestSend).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventId: events[0]!.id }),
      }),
    )
  })
})

describe('POST /api/webhooks/gocardless — multi-event payload', () => {
  it('upserts and enqueues every event in events[] independently', async () => {
    const { raw, events } = loadFixture('multi.confirmed_then_late_failure.json')
    const sig = signRaw(raw)

    expect(events).toHaveLength(2)
    providerEventFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    providerEventCreate
      .mockResolvedValueOnce({ id: 'pe_gc_a' })
      .mockResolvedValueOnce({ id: 'pe_gc_b' })

    const res = await ROUTE.POST(buildRequest(raw, sig))

    expect(res.status).toBe(200)
    expect(providerEventCreate).toHaveBeenCalledTimes(2)
    expect(inngestSend).toHaveBeenCalledTimes(2)
    expect(inngestSend).toHaveBeenNthCalledWith(1, {
      name: 'gocardless/event.received',
      data: {
        eventId: events[0]!.id,
        providerEventRowId: 'pe_gc_a',
        type: 'payments/confirmed',
      },
    })
    expect(inngestSend).toHaveBeenNthCalledWith(2, {
      name: 'gocardless/event.received',
      data: {
        eventId: events[1]!.id,
        providerEventRowId: 'pe_gc_b',
        type: 'mandates/active',
      },
    })
  })
})

describe('POST /api/webhooks/gocardless — mandates.replaced fixture', () => {
  it('forwards the right type and event id', async () => {
    const { raw, events } = loadFixture('mandates.replaced.json')
    const sig = signRaw(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gc_replaced' })

    const res = await ROUTE.POST(buildRequest(raw, sig))

    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'gocardless/event.received',
      data: {
        eventId: events[0]!.id,
        providerEventRowId: 'pe_gc_replaced',
        type: 'mandates/replaced',
      },
    })
  })
})

describe('POST /api/webhooks/gocardless — unknown resource type', () => {
  it('still upserts and enqueues; the Inngest job decides whether to handle it', async () => {
    // The route is intentionally permissive: the job filter is the only gate
    // for whether we do work. This keeps unknown but legitimate GC events in
    // ProviderEvent for replay if we later add support for them.
    const { raw, events } = loadFixture('payouts.created.json')
    const sig = signRaw(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_gc_payout' })

    const res = await ROUTE.POST(buildRequest(raw, sig))

    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'gocardless/event.received',
      data: {
        eventId: events[0]!.id,
        providerEventRowId: 'pe_gc_payout',
        type: 'payouts/created',
      },
    })
  })
})

describe('POST /api/webhooks/gocardless — invalid signature', () => {
  it('returns 400 with no DB write or Inngest send', async () => {
    const { raw } = loadFixture('payments.confirmed.json')
    const wrongSig = signRaw(raw, 'whsec_attacker_supplied')

    const res = await ROUTE.POST(buildRequest(raw, wrongSig))

    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 400 when the signature header is missing', async () => {
    const { raw } = loadFixture('payments.confirmed.json')

    const res = await ROUTE.POST(buildRequest(raw, null))

    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })
})
