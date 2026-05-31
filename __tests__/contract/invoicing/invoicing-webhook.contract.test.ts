// B2B Invoices Platform webhook contract test. Replays a signed payload
// through the real route handler with mocked DB-touching deps + Inngest,
// asserting we verify the HMAC over the RAW body, persist a ProviderEvent, and
// enqueue the processing job — and that an unsigned/forged request is 400'd.
//
// Mocks are declared via vi.hoisted so the factories can reference them
// (mirrors __tests__/contract/stripe.test.ts). CLAUDE.md §7.1, §8, §23.

import { createHmac } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const SECRET = 'whsec_contract_test'

const { inngestSend, upsertProviderEvent, loadInvoicingConfig } = vi.hoisted(() => ({
  inngestSend: vi.fn(),
  upsertProviderEvent: vi.fn(),
  loadInvoicingConfig: vi.fn(),
}))

vi.mock('@studymind/jobs', () => ({
  inngest: { send: inngestSend },
}))

vi.mock('@studymind/core/provider-events', () => ({
  upsertProviderEvent,
}))

// Mock the config loader so the route does not touch Postgres. The webhook
// secret it returns is what we sign with below.
vi.mock('@studymind/integration-invoicing/config', () => ({
  loadInvoicingConfig,
}))

import { POST } from '@/app/api/webhooks/invoicing/route'

beforeEach(() => {
  vi.clearAllMocks()
  loadInvoicingConfig.mockResolvedValue({
    baseUrl: 'https://b2b.studymind.co.uk',
    apiKey: 'sk_live_x',
    webhookSecret: SECRET,
    apiKeyLast4: 've_x',
    eventsCursor: null,
    streamCursor: null,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function signed(body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

const fixture = {
  id: 'evt_inv_0001',
  type: 'invoice.created',
  source: 'app',
  created_at: '2026-05-30T10:00:00Z',
  data: {
    entity_type: 'invoice',
    action: 'created',
    record: {
      id: 'inv_abc',
      invoice_number: 'INV-1000',
      partner_id: 'ptn_1',
      status: 'issued',
      grand_total: '720.00',
    },
  },
}

describe('invoicing webhook route', () => {
  it('verifies signature, persists ProviderEvent, enqueues job', async () => {
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: {
        'x-webhook-signature': signed(body),
        'x-webhook-event': 'invoice.created',
        'x-webhook-id': 'evt_inv_0001',
        'content-type': 'application/json',
      },
      body,
    })
    upsertProviderEvent.mockResolvedValue({ id: 'pe_1', created: true })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(upsertProviderEvent).toHaveBeenCalledOnce()
    expect(upsertProviderEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ provider: 'invoicing', eventId: 'evt_inv_0001' }),
    )
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'invoicing/event.received',
        data: expect.objectContaining({ eventId: 'evt_inv_0001', providerEventRowId: 'pe_1' }),
      }),
    )
  })

  it('does NOT re-enqueue a duplicate delivery (idempotent)', async () => {
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: { 'x-webhook-signature': signed(body), 'content-type': 'application/json' },
      body,
    })
    upsertProviderEvent.mockResolvedValue({ id: 'pe_1', created: false })

    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(upsertProviderEvent).toHaveBeenCalledOnce()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('rejects a forged signature with 400 and writes nothing', async () => {
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: {
        'x-webhook-signature': signed(body, 'whsec_WRONG'),
        'content-type': 'application/json',
      },
      body,
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(upsertProviderEvent).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('rejects a missing signature with 400 without touching the config', async () => {
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    // Cheapest rejection first — never decrypts when there's no signature.
    expect(loadInvoicingConfig).not.toHaveBeenCalled()
    expect(upsertProviderEvent).not.toHaveBeenCalled()
  })

  it('returns 503 (not 500) when the secret cannot be decrypted', async () => {
    // Simulates a misconfigured field-encryption backend (e.g. AWS_KMS_KEY_ID
    // placeholder with no real AWS account). The handler must NOT 500.
    loadInvoicingConfig.mockRejectedValueOnce(new Error('KMS decrypt failed'))
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: { 'x-webhook-signature': signed(body), 'content-type': 'application/json' },
      body,
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(upsertProviderEvent).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 503 when no webhook secret is configured', async () => {
    loadInvoicingConfig.mockResolvedValueOnce({
      baseUrl: 'https://b2b.studymind.co.uk',
      apiKey: 'sk_live_x',
      webhookSecret: null,
      apiKeyLast4: 've_x',
      eventsCursor: null,
      streamCursor: null,
    })
    const body = JSON.stringify(fixture)
    const req = new Request('http://localhost/api/webhooks/invoicing', {
      method: 'POST',
      headers: { 'x-webhook-signature': signed(body), 'content-type': 'application/json' },
      body,
    })

    const res = await POST(req)

    expect(res.status).toBe(503)
    expect(upsertProviderEvent).not.toHaveBeenCalled()
  })
})
