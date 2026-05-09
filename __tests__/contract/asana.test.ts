// Asana webhook contract test. CLAUDE.md §13, §23.
//
// Covers:
//   1. X-Hook-Secret handshake -> echoes header, persists AsanaWebhook.
//   2. Valid signature + allowed project -> ProviderEvent + Inngest enqueue.
//   3. Disallowed project -> 400, no DB writes.
//   4. Invalid signature -> 400, no DB writes.

import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  asanaWebhookCreate,
  asanaWebhookFindFirst,
  providerEventFindUnique,
  providerEventCreate,
} = vi.hoisted(() => ({
  asanaWebhookCreate: vi.fn(),
  asanaWebhookFindFirst: vi.fn(),
  providerEventFindUnique: vi.fn(),
  providerEventCreate: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    asanaWebhook: {
      create: asanaWebhookCreate,
      findFirst: asanaWebhookFindFirst,
    },
    providerEvent: {
      findUnique: providerEventFindUnique,
      create: providerEventCreate,
    },
  },
}))

import * as ROUTE from '@/app/api/webhooks/asana/route'
import { inngest } from '@studymind/jobs'

const inngestSend = vi.spyOn(inngest, 'send').mockResolvedValue(undefined as never)

const FIXTURES_DIR = resolve(__dirname, '../fixtures/asana')
const ALLOWED_PROJECT = '9900000000000001'
const WEBHOOK_SECRET = 'asana_test_secret_xxx'

function loadFixture(name: string): { raw: string } {
  return { raw: readFileSync(resolve(FIXTURES_DIR, name), 'utf8') }
}

function sign(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}

function buildRequest(
  rawBody: string,
  sig: string | null,
  projectGid: string = ALLOWED_PROJECT,
  hookSecret?: string,
): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (sig) headers.set('x-hook-signature', sig)
  if (hookSecret) headers.set('x-hook-secret', hookSecret)
  return new Request(`http://localhost/api/webhooks/asana?project=${projectGid}`, {
    method: 'POST',
    body: rawBody,
    headers,
  })
}

const ORIGINAL_PROJECTS = process.env['ASANA_ALLOWED_PROJECTS']

beforeEach(() => {
  process.env['ASANA_ALLOWED_PROJECTS'] = ALLOWED_PROJECT
  for (const fn of [
    asanaWebhookCreate,
    asanaWebhookFindFirst,
    providerEventFindUnique,
    providerEventCreate,
    inngestSend,
  ]) {
    fn.mockReset()
  }
  inngestSend.mockResolvedValue(undefined as never)
})

afterEach(() => {
  if (ORIGINAL_PROJECTS === undefined) delete process.env['ASANA_ALLOWED_PROJECTS']
  else process.env['ASANA_ALLOWED_PROJECTS'] = ORIGINAL_PROJECTS
})

describe('POST /api/webhooks/asana — handshake', () => {
  it('echoes the X-Hook-Secret header and persists AsanaWebhook', async () => {
    asanaWebhookCreate.mockResolvedValueOnce({ id: 'aw_1' })
    const res = await ROUTE.POST(buildRequest('', null, ALLOWED_PROJECT, WEBHOOK_SECRET))
    expect(res.status).toBe(200)
    expect(res.headers.get('x-hook-secret')).toBe(WEBHOOK_SECRET)
    expect(asanaWebhookCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: ALLOWED_PROJECT,
          webhookSecret: WEBHOOK_SECRET,
        }),
      }),
    )
  })

  it('rejects handshake for a disallowed project', async () => {
    const res = await ROUTE.POST(buildRequest('', null, '9900000000000999', WEBHOOK_SECRET))
    expect(res.status).toBe(400)
    expect(asanaWebhookCreate).not.toHaveBeenCalled()
  })
})

describe('POST /api/webhooks/asana — events', () => {
  it('valid signature + allowed project enqueues per task event', async () => {
    const { raw } = loadFixture('task.added.json')
    asanaWebhookFindFirst.mockResolvedValueOnce({ webhookSecret: WEBHOOK_SECRET })
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_asana_1' })

    const res = await ROUTE.POST(buildRequest(raw, sign(raw)))
    expect(res.status).toBe(200)
    expect(inngestSend).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'asana/event.received',
        data: expect.objectContaining({
          providerEventRowId: 'pe_asana_1',
          projectGid: ALLOWED_PROJECT,
          type: 'task.added',
        }),
      }),
    )
  })

  it('rejects invalid signature with 400 and no DB writes', async () => {
    const { raw } = loadFixture('task.added.json')
    asanaWebhookFindFirst.mockResolvedValueOnce({ webhookSecret: WEBHOOK_SECRET })

    const res = await ROUTE.POST(buildRequest(raw, sign(raw, 'wrong_secret')))
    expect(res.status).toBe(400)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('rejects events from a project outside the allowlist', async () => {
    const { raw } = loadFixture('task.added.json')
    const res = await ROUTE.POST(buildRequest(raw, sign(raw), '9999999999999999'))
    expect(res.status).toBe(400)
    expect(providerEventCreate).not.toHaveBeenCalled()
    expect(inngestSend).not.toHaveBeenCalled()
  })

  it('processes a task.changed event with its synthetic event id', async () => {
    const { raw } = loadFixture('task.changed.json')
    asanaWebhookFindFirst.mockResolvedValueOnce({ webhookSecret: WEBHOOK_SECRET })
    providerEventFindUnique.mockResolvedValueOnce(null)
    providerEventCreate.mockResolvedValueOnce({ id: 'pe_asana_2' })

    const res = await ROUTE.POST(buildRequest(raw, sign(raw)))
    expect(res.status).toBe(200)
    const call = inngestSend.mock.calls[0]?.[0] as
      | { data: { eventId: string; type: string } }
      | undefined
    expect(call).toBeTruthy()
    expect(call!.data.type).toBe('task.changed')
    expect(call!.data.eventId).toContain('1200000000000002')
  })
})
