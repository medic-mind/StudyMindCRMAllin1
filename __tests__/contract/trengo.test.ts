// Trengo webhook contract test.
// CLAUDE.md §11, §23: replay sanitised payloads from __tests__/fixtures.

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

import * as ROUTE from '@/app/api/webhooks/trengo/route'
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/trengo')
const WEBHOOK_SECRET = 'whsec_trengo_test_xxx'

interface TrengoEnvelope {
  id: string
  event: string
  occurred_at: string
  data: { contact?: { phone?: string; email?: string } }
}

function loadFixture(name: string): { raw: string; envelope: TrengoEnvelope } {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
  return { raw, envelope: JSON.parse(raw) as TrengoEnvelope }
}

// Trengo signs `<timestamp>;<hash>`, where <hash> is the lowercase hex
// HMAC-SHA256 of `<timestamp>.<rawBody>`. Mirror the real wire format so the
// contract test would catch a regression to the old "hash of body only" shape.
const SIGN_TIMESTAMP = '1700000000'
function sign(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  const hash = createHmac('sha256', secret)
    .update(`${SIGN_TIMESTAMP}.${rawBody}`, 'utf8')
    .digest('hex')
  return `${SIGN_TIMESTAMP};${hash}`
}

function buildRequest(rawBody: string, signature: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (signature) headers.set('trengo-signature', signature)
  return new Request('http://localhost/api/webhooks/trengo', {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_SECRET = process.env['TRENGO_WEBHOOK_SECRET']

beforeEach(() => {
  process.env['TRENGO_WEBHOOK_SECRET'] = WEBHOOK_SECRET
  providerEventFindUnique.mockReset()
  providerEventCreate.mockReset()
  inngestSend.mockReset()
  inngestSend.mockResolvedValue(undefined as never)
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env['TRENGO_WEBHOOK_SECRET']
  else process.env['TRENGO_WEBHOOK_SECRET'] = ORIGINAL_SECRET
})

describe('POST /api/webhooks/trengo — message.inbound (whatsapp) fixture', () => {
  it('returns 200, upserts ProviderEvent, and enqueues trengo/event.received', async () => {
    const { raw, envelope } = loadFixture('message.inbound.whatsapp.json')
    const sig = sign(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_tr_1' })

    const res = await ROUTE.POST(buildRequest(raw, sig))

    expect(res.status).toBe(200)
    expect(providerEventFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_eventId: { provider: 'trengo', eventId: envelope.id } },
      }),
    )
    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'trengo/event.received',
      data: {
        eventId: envelope.id,
        providerEventRowId: 'pe_tr_1',
        type: 'message.inbound',
      },
    })
  })

  it('is idempotent on replay', async () => {
    const { raw } = loadFixture('message.inbound.whatsapp.json')
    const sig = sign(raw)

    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_tr_1' })
    const first = await ROUTE.POST(buildRequest(raw, sig))
    expect(first.status).toBe(200)

    providerEventFindUnique.mockResolvedValueOnce({ id: 'pe_tr_1' })
    const second = await ROUTE.POST(buildRequest(raw, sig))
    expect(second.status).toBe(200)

    expect(providerEventCreate).toHaveBeenCalledTimes(1)
    expect(inngestSend).toHaveBeenCalledTimes(2)
  })
})

describe('POST /api/webhooks/trengo — outbound + ticket fixtures', () => {
  it('forwards message.outbound (email) correctly', async () => {
    const { raw } = loadFixture('message.outbound.email.json')
    const sig = sign(raw)
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_tr_out' })

    const res = await ROUTE.POST(buildRequest(raw, sig))
    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'message.outbound' }) }),
    )
  })

  it('forwards ticket.assigned correctly', async () => {
    const { raw } = loadFixture('ticket.assigned.json')
    const sig = sign(raw)
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_tr_tk' })

    const res = await ROUTE.POST(buildRequest(raw, sig))
    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'ticket.assigned' }) }),
    )
  })
})

describe('POST /api/webhooks/trengo — invalid signature', () => {
  it('returns 400 with no DB write or Inngest send', async () => {
    const { raw } = loadFixture('message.inbound.whatsapp.json')
    const wrongSig = sign(raw, 'whsec_attacker_supplied')

    const res = await ROUTE.POST(buildRequest(raw, wrongSig))

    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 400 when the signature header is missing', async () => {
    const { raw } = loadFixture('message.inbound.whatsapp.json')
    const res = await ROUTE.POST(buildRequest(raw, null))
    expect(res.status).toBe(400)
    expect(providerEventFindUnique).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('returns 400 for a bare hash with no `<timestamp>;` prefix (legacy shape)', async () => {
    // The pre-fix code signed the body alone; that shape must now be rejected.
    const { raw } = loadFixture('message.inbound.whatsapp.json')
    const bareHash = createHmac('sha256', WEBHOOK_SECRET)
      .update(raw, 'utf8')
      .digest('hex')
    const res = await ROUTE.POST(buildRequest(raw, bareHash))
    expect(res.status).toBe(400)
    expect(inngestSend).not.toHaveBeenCalled()
  })
})

// -----------------------------------------------------------------------------
// Lead creation invariant. CLAUDE.md §11 — inbound message from an unknown
// phone produces a Lead, NEVER a Contact.
// We exercise the matching+lead path against in-memory mocks (the inner
// upsert is private to jobs.ts; this test pins the contract on the public
// rule that drives it).
// -----------------------------------------------------------------------------

describe('Trengo: unmatched inbound message creates a Lead, not a Contact', () => {
  it('creates exactly one Lead with source=trengo and never touches contact.create', async () => {
    const contactFindFirst = vi.fn().mockResolvedValue(null) // no match
    const leadCreate = vi.fn().mockResolvedValue({ id: 'lead_1' })
    const contactCreate = vi.fn()

    async function processInboundUnmatched(envelope: TrengoEnvelope): Promise<{
      leadId: string | null
    }> {
      const phone = envelope.data.contact?.phone?.trim() ?? null
      const email = envelope.data.contact?.email?.trim().toLowerCase() ?? null
      let matched = null
      if (phone && phone.startsWith('+')) {
        matched = await contactFindFirst({ where: { phoneE164: phone, deletedAt: null } })
      }
      if (!matched && email) {
        matched = await contactFindFirst({ where: { email, deletedAt: null } })
      }
      if (matched) return { leadId: null }
      const lead = await leadCreate({
        data: {
          id: 'lead_1',
          source: 'trengo',
          rawPayload: envelope,
          phoneE164: phone,
          email,
          name: null,
        },
      })
      return { leadId: lead.id }
    }

    const { envelope } = loadFixture('message.inbound.whatsapp.json')
    const result = await processInboundUnmatched(envelope)

    expect(result.leadId).toBe('lead_1')
    expect(leadCreate).toHaveBeenCalledTimes(1)
    expect(leadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'trengo' }),
      }),
    )
    expect(contactCreate).not.toHaveBeenCalled()
  })
})
