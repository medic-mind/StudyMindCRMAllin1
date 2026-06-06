// Typed-client tests for the B2B Invoices Platform. A recording fake `fetch`
// asserts each method hits the right path + method, unwraps the `{ data }`
// envelope, and maps 401/403 to the distinct error types. Covers the full
// action surface the CRM drives (issue / cancel / reissue / duplicate /
// reminder / remove-payment / PDF / reference data) plus the SSE parser.

import { describe, expect, it } from 'vitest'

import {
  InvoicingReadOnlyError,
  InvoicingUnauthorizedError,
  createClient,
  parseSseEvent,
} from './client'

interface Call {
  url: string
  method: string
  body: string | undefined
}

function makeClient(responder: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined })
    return responder(url, init ?? {})
  }) as typeof fetch
  const client = createClient({ apiKey: 'sk_live_test', baseUrl: 'https://b2b.example', fetchImpl })
  return { client, calls }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

const API = 'https://b2b.example/api/v1'

describe('invoice lifecycle actions', () => {
  it('cancel posts to /cancel and unwraps the invoice', async () => {
    const { client, calls } = makeClient(() =>
      json({ data: { id: 'inv1', status: 'cancelled' } }),
    )
    const res = await client.cancelInvoice('inv1')
    expect(res.status).toBe('cancelled')
    expect(calls[0]).toMatchObject({ url: `${API}/invoices/inv1/cancel`, method: 'POST' })
  })

  it('reissue posts the issue_date when given', async () => {
    const { client, calls } = makeClient(() => json({ data: { id: 'inv1', status: 'issued' } }))
    await client.reissueInvoice('inv1', { issue_date: '2026-07-01' })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe(`${API}/invoices/inv1/reissue`)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ issue_date: '2026-07-01' })
  })

  it('duplicate posts to /duplicate and returns the new invoice', async () => {
    const { client, calls } = makeClient(() =>
      json({ data: { id: 'inv2', invoice_number: 'INV-1001', status: 'draft' } }),
    )
    const res = await client.duplicateInvoice('inv1')
    expect(res.id).toBe('inv2')
    expect(res.invoice_number).toBe('INV-1001')
    expect(calls[0]).toMatchObject({ url: `${API}/invoices/inv1/duplicate`, method: 'POST' })
  })

  it('getInvoiceActivity unwraps a { data: [...] } envelope', async () => {
    const { client } = makeClient(() =>
      json({ data: [{ id: 1, type: 'sent', created_at: '2026-06-01T00:00:00Z' }] }),
    )
    const rows = await client.getInvoiceActivity('inv1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.type).toBe('sent')
  })
})

describe('payments', () => {
  it('listPayments accepts a bare array', async () => {
    const { client } = makeClient(() => json([{ id: 'p1', amount: '200.00' }]))
    const rows = await client.listPayments('inv1')
    expect(rows[0]?.id).toBe('p1')
  })

  it('deletePayment DELETEs the nested path', async () => {
    const { client, calls } = makeClient(() => new Response(null, { status: 204 }))
    await client.deletePayment('inv1', 'p1')
    expect(calls[0]).toMatchObject({
      url: `${API}/invoices/inv1/payments/p1`,
      method: 'DELETE',
    })
  })
})

describe('reminder', () => {
  it('sendReminder posts the body and unwraps the result', async () => {
    const { client, calls } = makeClient(() =>
      json({ data: { sent: true, to: 'a@b.test', log_id: 'log1' } }),
    )
    const res = await client.sendReminder('inv1', { attach_pdf: true })
    expect(res).toEqual({ sent: true, to: 'a@b.test', log_id: 'log1' })
    expect(calls[0]?.url).toBe(`${API}/invoices/inv1/send-reminder`)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ attach_pdf: true })
  })
})

describe('PDF', () => {
  it('getInvoicePdfJson unwraps the base64 envelope', async () => {
    const { client } = makeClient(() =>
      json({ data: { invoice_number: 'INV-1', filename: 'INV-1.pdf', content_type: 'application/pdf', base64: 'AAAA' } }),
    )
    const pdf = await client.getInvoicePdfJson('inv1')
    expect(pdf.base64).toBe('AAAA')
  })

  it('getInvoicePdfBytes requests format=pdf and reads bytes + filename', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const { client, calls } = makeClient(
      () =>
        new Response(bytes, {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'inline; filename="INV-1000.pdf"',
          },
        }),
    )
    const res = await client.getInvoicePdfBytes('inv1', { disposition: 'inline' })
    expect(res.contentType).toBe('application/pdf')
    expect(res.filename).toBe('INV-1000.pdf')
    expect(new Uint8Array(res.bytes)).toEqual(bytes)
    expect(calls[0]?.url).toContain('format=pdf')
    expect(calls[0]?.url).toContain('disposition=inline')
  })

  it('getInvoicePdfBytes maps 401 to the unauthorized error', async () => {
    const { client } = makeClient(() => new Response('no', { status: 401 }))
    await expect(client.getInvoicePdfBytes('inv1')).rejects.toBeInstanceOf(
      InvoicingUnauthorizedError,
    )
  })
})

describe('reference data', () => {
  it('billingCompanies unwraps { data: [...] }', async () => {
    const { client } = makeClient(() => json({ data: [{ id: 'bc1', name: 'StudyMind Ltd' }] }))
    const rows = await client.getBillingCompanies()
    expect(rows[0]?.name).toBe('StudyMind Ltd')
  })

  it('bankAccounts accepts a bare array', async () => {
    const { client } = makeClient(() => json([{ id: 'ba1', name: 'HSBC', sort_code: '00-00-00' }]))
    const rows = await client.getBankAccounts()
    expect(rows[0]?.sort_code).toBe('00-00-00')
  })

  it('companySettings passes the object through', async () => {
    const { client } = makeClient(() => json({ prefix: 'INV', currency: 'GBP' }))
    const settings = await client.getCompanySettings()
    expect(settings['prefix']).toBe('INV')
  })
})

describe('webhooks + contacts', () => {
  it('listWebhooks unwraps a { data: [...] } envelope', async () => {
    const { client } = makeClient(() => json({ data: [{ id: 'wh1', url: 'https://x', secret: 's', event_types: ['*'] }] }))
    const rows = await client.listWebhooks()
    expect(rows[0]?.id).toBe('wh1')
  })

  it('getCustomerContacts hits the nested contacts path', async () => {
    const { client, calls } = makeClient(() => json({ data: [{ id: 1, name: 'Jo', email: 'jo@x.test' }] }))
    const rows = await client.getCustomerContacts('cus1')
    expect(rows[0]?.email).toBe('jo@x.test')
    expect(calls[0]?.url).toBe(`${API}/customers/cus1/contacts`)
  })
})

describe('error mapping on writes', () => {
  it('maps 403 to the read-only error', async () => {
    const { client } = makeClient(() => new Response('read only', { status: 403 }))
    await expect(client.cancelInvoice('inv1')).rejects.toBeInstanceOf(InvoicingReadOnlyError)
  })
})

describe('SSE parsing', () => {
  it('parses a data frame into a RawEvent', () => {
    const block = 'event: invoice.created\nid: 42\ndata: {"id":"evt_42","type":"invoice.created","source":"api","cursor":"42"}'
    const ev = parseSseEvent(block)
    expect(ev?.id).toBe('evt_42')
    expect(ev?.source).toBe('api')
  })

  it('ignores heartbeat comments and garbage', () => {
    expect(parseSseEvent(': hb')).toBeNull()
    expect(parseSseEvent('data: not json')).toBeNull()
  })

  it('streamEvents yields each frame from the body stream', async () => {
    const frames =
      'event: invoice.created\ndata: {"id":"e1","type":"invoice.created"}\n\n' +
      ': hb\n\n' +
      'event: payment.created\ndata: {"id":"e2","type":"payment.created"}\n\n'
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frames))
        controller.close()
      },
    })
    const { client } = makeClient(() => new Response(stream, { status: 200 }))
    const seen: string[] = []
    for await (const ev of client.streamEvents({ since: '0' })) {
      seen.push(ev.id)
    }
    expect(seen).toEqual(['e1', 'e2'])
  })
})
