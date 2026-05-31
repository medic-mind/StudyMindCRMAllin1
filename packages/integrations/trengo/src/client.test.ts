// Tests for the Trengo client label + note methods (ADR 0020 Phase 6f).
// Pins the API contract (endpoint + body shape) since these endpoints are
// driven from the CRM and we cannot exercise them against a live workspace
// in CI.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@studymind/db', () => ({ db: {} }))

import { createClientForAgent } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

async function clientWith(fetchImpl: typeof fetch) {
  return createClientForAgent({ agentId: 'u_1', token: 'tok', fetchImpl })
}

describe('Trengo client — labels + notes', () => {
  it('listLabels GETs /labels and unwraps the data array', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 1, name: 'VIP' }, { id: 2, name: 'Urgent' }] }),
    ) as unknown as typeof fetch
    const client = await clientWith(fetchImpl)
    const labels = await client.listLabels()
    expect(labels).toEqual([
      { id: 1, name: 'VIP' },
      { id: 2, name: 'Urgent' },
    ])
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/labels')
    expect(init.method).toBe('GET')
  })

  it('createLabel POSTs the name and normalises the response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: 9, name: 'New tag', color: '#abc' } }),
    ) as unknown as typeof fetch
    const client = await clientWith(fetchImpl)
    const label = await client.createLabel('New tag')
    expect(label).toEqual({ id: 9, name: 'New tag', color: '#abc' })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/labels')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'New tag' })
  })

  it('attachLabel POSTs label_id to the ticket labels collection', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
    const client = await clientWith(fetchImpl)
    await client.attachLabel(42, 7)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/tickets/42/labels')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ label_id: 7 })
  })

  it('detachLabel DELETEs the ticket label by id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch
    const client = await clientWith(fetchImpl)
    await client.detachLabel(42, 7)
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/tickets/42/labels/7')
    expect(init.method).toBe('DELETE')
  })

  it('addInternalNote POSTs the body to the ticket notes collection', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { id: 555 } }),
    ) as unknown as typeof fetch
    const client = await clientWith(fetchImpl)
    const note = await client.addInternalNote(42, 'team only')
    expect(note).toEqual({ id: 555 })
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toContain('/tickets/42/notes')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ body: 'team only' })
  })
})
