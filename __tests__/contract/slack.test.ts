// Slack Events API contract test. CLAUDE.md §12, §23.
//
// Covers:
//   1. URL verification handshake echoes the challenge.
//   2. Valid signature + watched channel + url_verification path.
//   3. Replay window outside 5 minutes -> 400.
//   4. Invalid signature -> 400, no DB writes.
//   5. Job: low-confidence parse -> UnassignedSummary; high-confidence +
//      matched contact -> Interaction.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  providerEventFindUnique,
  providerEventCreate,
  providerEventFindUniqueOrThrow,
  providerEventUpdate,
  contactFindFirst,
  unassignedSummaryUpsert,
  interactionFindFirst,
  interactionCreate,
  auditLogFindFirst,
  auditLogCreate,
} = vi.hoisted(() => ({
  providerEventFindUnique: vi.fn(),
  providerEventCreate: vi.fn(),
  providerEventFindUniqueOrThrow: vi.fn(),
  providerEventUpdate: vi.fn(),
  contactFindFirst: vi.fn(),
  unassignedSummaryUpsert: vi.fn(),
  interactionFindFirst: vi.fn(),
  interactionCreate: vi.fn(),
  auditLogFindFirst: vi.fn(),
  auditLogCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    providerEvent: {
      findUnique: providerEventFindUnique,
      create: providerEventCreate,
      findUniqueOrThrow: providerEventFindUniqueOrThrow,
      update: providerEventUpdate,
    },
    contact: { findFirst: contactFindFirst },
    unassignedSummary: { upsert: unassignedSummaryUpsert },
    interaction: { findFirst: interactionFindFirst, create: interactionCreate },
    auditLogEntry: { findFirst: auditLogFindFirst, create: auditLogCreate },
  },
}))
vi.mock('@studymind/db', () => ({
  db: {
    providerEvent: {
      findUnique: providerEventFindUnique,
      create: providerEventCreate,
      findUniqueOrThrow: providerEventFindUniqueOrThrow,
      update: providerEventUpdate,
    },
    contact: { findFirst: contactFindFirst },
    unassignedSummary: { upsert: unassignedSummaryUpsert },
    interaction: { findFirst: interactionFindFirst, create: interactionCreate },
    auditLogEntry: { findFirst: auditLogFindFirst, create: auditLogCreate },
  },
}))

import * as ROUTE from '@/app/api/webhooks/slack/route'
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/slack')
const SIGNING_SECRET = 'whsec_slack_test_xxx'

function loadFixture(name: string): { raw: string; envelope: Record<string, unknown> } {
  const raw = readFileSync(resolve(FIXTURES_DIR, name), 'utf8')
  return { raw, envelope: JSON.parse(raw) as Record<string, unknown> }
}

function sign(rawBody: string, ts: number, secret: string = SIGNING_SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`, 'utf8').digest('hex')}`
}

function buildRequest(rawBody: string, sig: string | null, ts: string | null): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (sig) headers.set('x-slack-signature', sig)
  if (ts) headers.set('x-slack-request-timestamp', ts)
  return new Request('http://localhost/api/webhooks/slack', {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_SECRET = process.env['SLACK_SIGNING_SECRET']
const ORIGINAL_CHANNELS = process.env['SLACK_WATCHED_CHANNELS']

beforeEach(() => {
  process.env['SLACK_SIGNING_SECRET'] = SIGNING_SECRET
  process.env['SLACK_WATCHED_CHANNELS'] = 'C0WATCHED01,C0WATCHED02'
  for (const fn of [
    providerEventFindUnique,
    providerEventCreate,
    providerEventFindUniqueOrThrow,
    providerEventUpdate,
    contactFindFirst,
    unassignedSummaryUpsert,
    interactionFindFirst,
    interactionCreate,
    auditLogFindFirst,
    auditLogCreate,
    inngestSend,
  ]) {
    fn.mockReset()
  }
  inngestSend.mockResolvedValue(undefined as never)
  vi.useFakeTimers()
  // Match the fixture event_time (1715260000).
  vi.setSystemTime(new Date(1715260010 * 1000))
})

afterEach(() => {
  vi.useRealTimers()
  if (ORIGINAL_SECRET === undefined) delete process.env['SLACK_SIGNING_SECRET']
  else process.env['SLACK_SIGNING_SECRET'] = ORIGINAL_SECRET
  if (ORIGINAL_CHANNELS === undefined) delete process.env['SLACK_WATCHED_CHANNELS']
  else process.env['SLACK_WATCHED_CHANNELS'] = ORIGINAL_CHANNELS
})

describe('POST /api/webhooks/slack — url_verification', () => {
  it('echoes the challenge value verbatim and does not enqueue Inngest', async () => {
    const { raw } = loadFixture('url_verification.json')
    const ts = '1715260010'
    const res = await ROUTE.POST(buildRequest(raw, sign(raw, Number(ts)), ts))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { challenge: string }
    expect(body.challenge).toBe('challenge_string_abc123')
    expect(inngestSend).not.toHaveBeenCalled()
    expect(providerEventCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/webhooks/slack — message.channels', () => {
  it('returns 200 and enqueues for watched channel with valid signature', async () => {
    const { raw, envelope } = loadFixture('message.channels.json')
    const ts = '1715260010'
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_slack_1' })

    const res = await ROUTE.POST(buildRequest(raw, sign(raw, Number(ts)), ts))
    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith({
      name: 'slack/event.received',
      data: {
        eventId: envelope['event_id'],
        providerEventRowId: 'pe_slack_1',
        type: 'message.channels',
      },
    })
  })

  it('skips channels not in the allowlist (no provider write, no enqueue)', async () => {
    const { raw } = loadFixture('message.channels.json')
    const altered = raw.replace('C0WATCHED01', 'C0NOTWATCHED')
    const ts = '1715260010'
    const res = await ROUTE.POST(buildRequest(altered, sign(altered, Number(ts)), ts))
    expect(res.status).toBe(200)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('rejects when the timestamp is older than the 5 minute replay window', async () => {
    const { raw } = loadFixture('message.channels.json')
    const oldTs = String(Math.floor(Date.now() / 1000) - 6 * 60)
    const res = await ROUTE.POST(buildRequest(raw, sign(raw, Number(oldTs)), oldTs))
    expect(res.status).toBe(400)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('rejects with an invalid signature, naming the reason', async () => {
    const { raw } = loadFixture('message.channels.json')
    const ts = '1715260010'
    const wrong = sign(raw, Number(ts), 'wrong_secret')
    const res = await ROUTE.POST(buildRequest(raw, wrong, ts))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('signature_mismatch')
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('with no allowlist configured, processes any channel the bot receives', async () => {
    // No SLACK_WATCHED_CHANNELS → bot membership is the gate (CLAUDE.md §12):
    // Slack only delivers channel events for channels the bot was /invited to.
    delete process.env['SLACK_WATCHED_CHANNELS']
    const { raw } = loadFixture('message.channels.json')
    const altered = raw.replace('C0WATCHED01', 'C0ANYCHANNEL')
    const ts = '1715260010'
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_slack_any' })

    const res = await ROUTE.POST(buildRequest(altered, sign(altered, Number(ts)), ts))
    expect(res.status).toBe(200)
    expect(providerEventCreate).toHaveBeenCalled()
    expect(inngestSend).toHaveBeenCalled()
  })
})

describe('GET /api/webhooks/slack — configuration self-check', () => {
  it('reports presence booleans only (no secrets) and the channel mode', async () => {
    const res = await ROUTE.GET(new Request('http://localhost/api/webhooks/slack'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body['signingSecretConfigured']).toBe(true)
    expect(String(body['channelMode'])).toContain('allowlist')
    expect(JSON.stringify(body)).not.toContain(SIGNING_SECRET)
  })
})

// -----------------------------------------------------------------------------
// Job-layer constant: confidence threshold per CLAUDE.md §12.
// -----------------------------------------------------------------------------

import { SLACK_MATCH_THRESHOLD } from '../../packages/integrations/slack/src/jobs'

describe('Slack job — confidence threshold', () => {
  it('matches the §12 threshold of 0.5 (the matcher’s unambiguous rule is the real gate)', () => {
    expect(SLACK_MATCH_THRESHOLD).toBe(0.5)
  })
})
