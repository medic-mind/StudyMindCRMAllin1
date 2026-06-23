// listIngestChannelIds: the allowlist when set, else EVERY member channel.
// Regression guard for the bug where an unset SLACK_WATCHED_CHANNELS made the
// pull enumerate ZERO channels (so nothing was ever ingested).

import { afterEach, describe, expect, it, vi } from 'vitest'

import { listIngestChannelIds } from './client'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

const ORIGINAL = process.env['SLACK_WATCHED_CHANNELS']
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['SLACK_WATCHED_CHANNELS']
  else process.env['SLACK_WATCHED_CHANNELS'] = ORIGINAL
})

describe('listIngestChannelIds', () => {
  it('returns the allowlist verbatim when set (no API call)', async () => {
    process.env['SLACK_WATCHED_CHANNELS'] = 'C111, C222'
    const fetchMock = vi.fn()
    const ids = await listIngestChannelIds({
      token: 'xoxb-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(ids).toEqual(['C111', 'C222'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('auto-discovers EVERY member channel when no allowlist is set', async () => {
    delete process.env['SLACK_WATCHED_CHANNELS']
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/conversations.list')) {
        return jsonResponse({
          ok: true,
          channels: [
            { id: 'C1', name: 'general', is_member: true, is_private: false },
            { id: 'C2', name: 'random', is_member: true, is_private: false },
            { id: 'C3', name: 'not-joined', is_member: false, is_private: false },
          ],
        })
      }
      return jsonResponse({ ok: true })
    })
    const ids = await listIngestChannelIds({
      token: 'xoxb-test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    // Only channels the bot is a MEMBER of (history works only when joined).
    expect(ids).toEqual(['C1', 'C2'])
  })
})
