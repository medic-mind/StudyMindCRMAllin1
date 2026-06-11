// Pins the GoCardless client's HTTP contract (ADR 0038): endpoint paths,
// resource-wrapped bodies, Idempotency-Key headers, and keyset-cursor list
// handling. A captured fetch double — no network (CLAUDE.md §23.2).

import { afterEach, describe, expect, it } from 'vitest'

import { __resetClientForTests, createClient } from './client'

interface CapturedCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function makeFetch(responses: Record<string, unknown>) {
  const calls: CapturedCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const path = new URL(url).pathname + new URL(url).search
    calls.push({
      url: path,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })
    const match = Object.entries(responses).find(([key]) => path.startsWith(key))
    return new Response(JSON.stringify(match?.[1] ?? {}), { status: 200 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

afterEach(() => __resetClientForTests())

describe('gocardless client contract', () => {
  it('creates a subscription with a wrapped body and Idempotency-Key', async () => {
    const { calls, fetchImpl } = makeFetch({
      '/subscriptions': { subscriptions: { id: 'SB1', status: 'active' } },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    const res = await client.createSubscription(
      {
        amount: 4000,
        currency: 'GBP',
        interval_unit: 'monthly',
        day_of_month: 1,
        links: { mandate: 'MD1' },
      },
      'sub_create:req_1',
    )
    expect(res.id).toBe('SB1')
    const call = calls[0]!
    expect(call.url).toBe('/subscriptions')
    expect(call.method).toBe('POST')
    expect(call.headers['Idempotency-Key']).toBe('sub_create:req_1')
    expect(call.body).toEqual({
      subscriptions: {
        amount: 4000,
        currency: 'GBP',
        interval_unit: 'monthly',
        day_of_month: 1,
        links: { mandate: 'MD1' },
      },
    })
  })

  it('hits the action endpoints for cancel / pause / resume / retry', async () => {
    const { calls, fetchImpl } = makeFetch({
      '/subscriptions/SB1/actions/cancel': { subscriptions: { id: 'SB1', status: 'cancelled' } },
      '/subscriptions/SB1/actions/pause': { subscriptions: { id: 'SB1', status: 'paused' } },
      '/subscriptions/SB1/actions/resume': { subscriptions: { id: 'SB1', status: 'active' } },
      '/payments/PM1/actions/retry': { payments: { id: 'PM1', status: 'submitted' } },
      '/payments/PM1/actions/cancel': { payments: { id: 'PM1', status: 'cancelled' } },
      '/mandates/MD1/actions/cancel': { mandates: { id: 'MD1', status: 'cancelled' } },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    await client.cancelSubscription('SB1')
    await client.pauseSubscription('SB1')
    await client.resumeSubscription('SB1')
    await client.retryPayment('PM1')
    await client.cancelPayment('PM1')
    await client.cancelMandate('MD1')
    expect(calls.map((c) => c.url)).toEqual([
      '/subscriptions/SB1/actions/cancel',
      '/subscriptions/SB1/actions/pause',
      '/subscriptions/SB1/actions/resume',
      '/payments/PM1/actions/retry',
      '/payments/PM1/actions/cancel',
      '/mandates/MD1/actions/cancel',
    ])
    expect(calls.every((c) => c.method === 'POST')).toBe(true)
  })

  it('paginates lists with the after cursor and surfaces the next cursor', async () => {
    const { calls, fetchImpl } = makeFetch({
      '/customers': {
        customers: [{ id: 'CU1', created_at: '2026-01-01T00:00:00Z' }],
        meta: { cursors: { after: 'CU1' }, limit: 200 },
      },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    const page = await client.listCustomers({ after: 'CU0', limit: 200 })
    expect(page.items).toHaveLength(1)
    expect(page.after).toBe('CU1')
    expect(calls[0]!.url).toBe('/customers?after=CU0&limit=200')
  })

  it('returns a null cursor on the last page', async () => {
    const { fetchImpl } = makeFetch({
      '/payments': { payments: [], meta: { cursors: { after: null }, limit: 200 } },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    const page = await client.listPayments()
    expect(page.items).toEqual([])
    expect(page.after).toBeNull()
  })

  it('lists and fetches payouts', async () => {
    const { calls, fetchImpl } = makeFetch({
      '/payouts/PO1': { payouts: { id: 'PO1', status: 'paid', amount: 50000, currency: 'GBP', created_at: '2026-01-02T00:00:00Z' } },
      '/payouts': {
        payouts: [
          { id: 'PO1', status: 'paid', amount: 50000, currency: 'GBP', created_at: '2026-01-02T00:00:00Z' },
        ],
        meta: { cursors: { after: null }, limit: 200 },
      },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    const page = await client.listPayouts({ limit: 200 })
    expect(page.items[0]!.id).toBe('PO1')
    const payout = await client.getPayout('PO1')
    expect(payout.status).toBe('paid')
    expect(calls.map((c) => c.url)).toEqual(['/payouts?limit=200', '/payouts/PO1'])
  })

  it('completes a redirect flow with the session token', async () => {
    const { calls, fetchImpl } = makeFetch({
      '/redirect_flows/RE1/actions/complete': {
        redirect_flows: { id: 'RE1', redirect_url: '', links: { mandate: 'MD1' } },
      },
    })
    const client = createClient({ accessToken: 't', environment: 'sandbox', fetchImpl })
    const flow = await client.completeRedirectFlow('RE1', 'session_123')
    expect(flow.links.mandate).toBe('MD1')
    expect(calls[0]!.body).toEqual({ data: { session_token: 'session_123' } })
  })
})
