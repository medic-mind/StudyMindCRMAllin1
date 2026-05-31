// Universal lead endpoint contract test (ADR 0023). Drives the real
// POST /api/leads handler with the DB-touching ingest core + Inngest mocked,
// asserting: an authenticated Contact-Form-7 (form-encoded) submission parses
// and reaches ingestLead; a keyless request is 401'd; an empty body is 400'd;
// and a deduped result is surfaced. CLAUDE.md §7.1, §23.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MASTER = 'lead-master-token-contract'

const { ingestLead } = vi.hoisted(() => ({ ingestLead: vi.fn() }))

// The ingest core (ProviderEvent + Lead + audit + enqueue) is unit/integration
// tested elsewhere; here we isolate the route's auth + body parsing.
vi.mock('@/lib/leads/ingest', () => ({ ingestLead }))
// The master-token path never touches the DB; stub the import so it resolves.
vi.mock('@/lib/db', () => ({ db: {} }))

import { POST } from '@/app/api/leads/route'

function post(body: string, headers: Record<string, string>, url = 'http://localhost/api/leads') {
  return POST(new Request(url, { method: 'POST', headers, body }) as Request)
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env['LEAD_WEBHOOK_BEARER_TOKEN'] = MASTER
  ingestLead.mockResolvedValue({ id: 'lead_contract_1', deduped: false })
})

afterEach(() => {
  delete process.env['LEAD_WEBHOOK_BEARER_TOKEN']
})

describe('POST /api/leads', () => {
  it('accepts an authenticated CF7 form-encoded submission and ingests it', async () => {
    const body = new URLSearchParams({
      'your-name': 'Test Family A1',
      'tel-146': '07700 900123',
      email: 'a1@example.test',
      'your-message': 'Interested in UCAT preparation.',
    }).toString()

    const res = await post(body, {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${MASTER}`,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; id?: string }
    expect(json.ok).toBe(true)
    expect(json.id).toBe('lead_contract_1')

    expect(ingestLead).toHaveBeenCalledTimes(1)
    const arg = ingestLead.mock.calls[0]![0] as {
      sourceId: string | null
      rawInput: { fields: Record<string, string> }
    }
    expect(arg.sourceId).toBeNull() // master token → no LeadSource
    expect(arg.rawInput.fields['email']).toBe('a1@example.test')
    expect(arg.rawInput.fields['tel-146']).toBe('07700 900123')
  })

  it('accepts a JSON submission and a ?key= query param', async () => {
    const res = await post(
      JSON.stringify({ name: 'Test B2', email: 'b2@example.test' }),
      { 'content-type': 'application/json' },
      `http://localhost/api/leads?key=${MASTER}`,
    )
    expect(res.status).toBe(200)
    expect(ingestLead).toHaveBeenCalledTimes(1)
  })

  it('rejects a request with no API key', async () => {
    const res = await post('email=x@y.test', {
      'content-type': 'application/x-www-form-urlencoded',
    })
    expect(res.status).toBe(401)
    expect(ingestLead).not.toHaveBeenCalled()
  })

  it('400s an empty submission', async () => {
    const res = await post('', {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${MASTER}`,
    })
    expect(res.status).toBe(400)
    expect(ingestLead).not.toHaveBeenCalled()
  })

  it('surfaces a deduped ingest result', async () => {
    ingestLead.mockResolvedValueOnce({ id: null, deduped: true })
    const res = await post('email=dupe@example.test', {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${MASTER}`,
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { ok: boolean; deduped?: boolean }
    expect(json.deduped).toBe(true)
  })
})
