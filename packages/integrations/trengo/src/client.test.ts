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

function makeFetch(body: unknown) {
  return vi.fn(async () => jsonResponse(body))
}

async function clientWith(fetchMock: ReturnType<typeof makeFetch>) {
  return createClientForAgent({
    agentId: 'u_1',
    token: 'tok',
    fetchImpl: fetchMock as unknown as typeof fetch,
  })
}

describe('Trengo client — labels + notes', () => {
  it('listLabels GETs /labels and unwraps the data array', async () => {
    const fetchMock = makeFetch({ data: [{ id: 1, name: 'VIP' }, { id: 2, name: 'Urgent' }] })
    const client = await clientWith(fetchMock)
    const labels = await client.listLabels()
    expect(labels).toEqual([
      { id: 1, name: 'VIP' },
      { id: 2, name: 'Urgent' },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/labels'),
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('createLabel POSTs the name and normalises the response', async () => {
    const fetchMock = makeFetch({ data: { id: 9, name: 'New tag', color: '#abc' } })
    const client = await clientWith(fetchMock)
    const label = await client.createLabel('New tag')
    expect(label).toEqual({ id: 9, name: 'New tag', color: '#abc' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/labels'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'New tag' }) }),
    )
  })

  it('attachLabel POSTs label_id to the ticket labels collection', async () => {
    const fetchMock = makeFetch({})
    const client = await clientWith(fetchMock)
    await client.attachLabel(42, 7)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tickets/42/labels'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ label_id: 7 }) }),
    )
  })

  it('detachLabel DELETEs the ticket label by id', async () => {
    const fetchMock = makeFetch({})
    const client = await clientWith(fetchMock)
    await client.detachLabel(42, 7)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tickets/42/labels/7'),
      expect.objectContaining({ method: 'DELETE' }),
    )
  })

  it('addInternalNote POSTs the body to the ticket notes collection', async () => {
    const fetchMock = makeFetch({ data: { id: 555 } })
    const client = await clientWith(fetchMock)
    const note = await client.addInternalNote(42, 'team only')
    expect(note).toEqual({ id: 555 })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/tickets/42/notes'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ body: 'team only' }) }),
    )
  })
})
