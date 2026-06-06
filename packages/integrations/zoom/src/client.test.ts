import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { buildUrlValidationResponse, verifyWebhookSignature } from './client'

const SECRET = 'test-secret-token'

describe('verifyWebhookSignature', () => {
  function sign(body: string, ts: string): string {
    const mac = createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex')
    return `v0=${mac}`
  }

  it('accepts a correctly signed payload', () => {
    const body = '{"event":"recording.completed"}'
    const ts = '1700000000'
    expect(
      verifyWebhookSignature({ rawBody: body, signature: sign(body, ts), timestamp: ts, secret: SECRET }),
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const ts = '1700000000'
    const sig = sign('{"event":"recording.completed"}', ts)
    expect(
      verifyWebhookSignature({ rawBody: '{"event":"hacked"}', signature: sig, timestamp: ts, secret: SECRET }),
    ).toBe(false)
  })

  it('rejects when signature / timestamp / secret missing', () => {
    expect(verifyWebhookSignature({ rawBody: 'x', signature: null, timestamp: '1', secret: SECRET })).toBe(false)
    expect(verifyWebhookSignature({ rawBody: 'x', signature: 'v0=abc', timestamp: null, secret: SECRET })).toBe(false)
    expect(verifyWebhookSignature({ rawBody: 'x', signature: 'v0=abc', timestamp: '1', secret: null })).toBe(false)
  })
})

describe('buildUrlValidationResponse', () => {
  it('echoes the plainToken and its HMAC', () => {
    const res = buildUrlValidationResponse('abc123', SECRET)
    expect(res?.plainToken).toBe('abc123')
    expect(res?.encryptedToken).toBe(createHmac('sha256', SECRET).update('abc123').digest('hex'))
  })

  it('returns null without a secret', () => {
    expect(buildUrlValidationResponse('abc123', null)).toBeNull()
  })
})
