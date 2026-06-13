// Pins the Slack client's conversations.list contract: GET with query-string
// args (not a JSON body), bounded cursor pagination, archived rows dropped,
// alphabetical ordering, and `missing_scope` surfacing as a SlackApiError the
// router can map to a friendly "re-install with channels:read" message.

import { describe, expect, it, vi } from 'vitest'

import { createClient, SlackApiError } from './client'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('listChannels', () => {
  it('pages with the cursor, drops archived, sorts by name, maps is_member', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url)
      calls.push(u)
      if (!u.includes('cursor=')) {
        return jsonResponse({
          ok: true,
          channels: [
            { id: 'C2', name: 'zeta', is_member: false },
            { id: 'C1', name: 'alerts', is_member: true },
            { id: 'C9', name: 'old', is_member: true, is_archived: true },
          ],
          response_metadata: { next_cursor: 'page2' },
        })
      }
      return jsonResponse({
        ok: true,
        channels: [{ id: 'C3', name: 'finance', is_member: true }],
        response_metadata: { next_cursor: '' },
      })
    }) as unknown as typeof fetch

    const client = createClient({ token: 'xoxb-test', fetchImpl })
    const channels = await client.listChannels()

    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain('/conversations.list?')
    expect(calls[0]).toContain('types=public_channel')
    expect(calls[1]).toContain('cursor=page2')
    expect(channels).toEqual([
      { id: 'C1', name: 'alerts', isMember: true, isPrivate: false },
      { id: 'C3', name: 'finance', isMember: true, isPrivate: false },
      { id: 'C2', name: 'zeta', isMember: false, isPrivate: false },
    ])
  })

  it('surfaces missing_scope as a SlackApiError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'missing_scope' }),
    ) as unknown as typeof fetch
    const client = createClient({ token: 'xoxb-test', fetchImpl })
    await expect(client.listChannels()).rejects.toMatchObject({
      name: 'SlackApiError',
      slackError: 'missing_scope',
    })
  })

  it('throws without a token', () => {
    const prev = process.env['SLACK_BOT_TOKEN']
    delete process.env['SLACK_BOT_TOKEN']
    try {
      expect(() => createClient()).toThrow(/SLACK_BOT_TOKEN/)
    } finally {
      if (prev !== undefined) process.env['SLACK_BOT_TOKEN'] = prev
    }
  })
})

describe('chatPostMessage', () => {
  it('POSTs JSON and returns the ts', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toMatchObject({ channel: 'C1', text: 'hi' })
      return jsonResponse({ ok: true, channel: 'C1', ts: '123.456' })
    }) as unknown as typeof fetch
    const client = createClient({ token: 'xoxb-test', fetchImpl })
    const res = await client.chatPostMessage({ channel: 'C1', text: 'hi' })
    expect(res.ts).toBe('123.456')
  })

  it('maps a Slack error to SlackApiError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: 'not_in_channel' }),
    ) as unknown as typeof fetch
    const client = createClient({ token: 'xoxb-test', fetchImpl })
    await expect(
      client.chatPostMessage({ channel: 'C1', text: 'hi' }),
    ).rejects.toBeInstanceOf(SlackApiError)
  })
})
