// Pins the channel-browser client behaviour: private+public listing with a
// graceful fallback when groups:read is missing, and the auth.test identity
// used by the UI to name the exact bot to /invite.

import { describe, expect, it, vi } from 'vitest'

import { createClient } from './client'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('Slack client — listChannels + identity', () => {
  it('asks for public+private and surfaces is_member/is_private', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/conversations.list')) {
        expect(url).toContain('public_channel%2Cprivate_channel')
        return jsonResponse({
          ok: true,
          channels: [
            { id: 'C1', name: 'general', is_member: true, is_private: false },
            { id: 'G1', name: 'ops-private', is_member: false, is_private: true },
          ],
        })
      }
      return jsonResponse({ ok: true })
    })
    const client = createClient({ token: 'xoxb-test', fetchImpl: fetchMock as unknown as typeof fetch })
    const channels = await client.listChannels()
    expect(channels).toEqual([
      { id: 'C1', name: 'general', isMember: true, isPrivate: false },
      { id: 'G1', name: 'ops-private', isMember: false, isPrivate: true },
    ])
  })

  it('falls back to public-only when groups:read is missing', async () => {
    let calls = 0
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/conversations.list')) {
        calls += 1
        if (url.includes('private_channel')) {
          return jsonResponse({ ok: false, error: 'missing_scope' })
        }
        return jsonResponse({
          ok: true,
          channels: [{ id: 'C1', name: 'general', is_member: true, is_private: false }],
        })
      }
      return jsonResponse({ ok: true })
    })
    const client = createClient({ token: 'xoxb-test', fetchImpl: fetchMock as unknown as typeof fetch })
    const channels = await client.listChannels()
    expect(calls).toBe(2)
    expect(channels).toHaveLength(1)
    expect(channels[0]!.id).toBe('C1')
  })

  it('identity() reads the bot + team name from auth.test', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toContain('/auth.test')
      return jsonResponse({ ok: true, user: 'studymind_crm', team: 'StudyMind' })
    })
    const client = createClient({ token: 'xoxb-test', fetchImpl: fetchMock as unknown as typeof fetch })
    await expect(client.identity()).resolves.toEqual({
      botName: 'studymind_crm',
      teamName: 'StudyMind',
    })
  })
})
