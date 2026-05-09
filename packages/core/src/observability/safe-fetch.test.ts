import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isAllowedHost } from './safe-fetch-allowlist'
import { safeFetch } from './safe-fetch'

const realFetch = globalThis.fetch
const realEnv = process.env.NODE_ENV

afterEach(() => {
  globalThis.fetch = realFetch
  process.env.NODE_ENV = realEnv
})

describe('isAllowedHost', () => {
  it('matches exact entries', () => {
    expect(isAllowedHost('api.stripe.com')).toBe(true)
    expect(isAllowedHost('api.openai.com')).toBe(true)
    expect(isAllowedHost('booking.studymind.co.uk')).toBe(true)
  })

  it('matches wildcards', () => {
    expect(isAllowedHost('foo.amazonaws.com')).toBe(true)
    expect(isAllowedHost('o12345.ingest.sentry.io')).toBe(true)
    expect(isAllowedHost('myteam.slack.com')).toBe(true)
  })

  it('rejects unrelated hosts', () => {
    expect(isAllowedHost('evil.example')).toBe(false)
    expect(isAllowedHost('169.254.169.254')).toBe(false)
    expect(isAllowedHost('localhost')).toBe(false)
  })
})

describe('safeFetch', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
  })

  it('bypasses host check in NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'test'
    const res = await safeFetch('https://anything.example/path')
    expect(res.status).toBe(200)
    expect(globalThis.fetch).toHaveBeenCalledOnce()
  })

  it('allows allowlisted hosts in production', async () => {
    process.env.NODE_ENV = 'production'
    const res = await safeFetch('https://api.stripe.com/v1/charges')
    expect(res.status).toBe(200)
  })

  it('rejects non-allowlisted hosts in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(safeFetch('https://evil.example/x')).rejects.toThrow(
      /OUTBOUND_HOST_BLOCKED|Host not allowlisted/,
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('rejects non-https schemes in production', async () => {
    process.env.NODE_ENV = 'production'
    await expect(safeFetch('file:///etc/passwd')).rejects.toThrow(
      /OUTBOUND_HOST_BLOCKED|Disallowed scheme/,
    )
  })
})
