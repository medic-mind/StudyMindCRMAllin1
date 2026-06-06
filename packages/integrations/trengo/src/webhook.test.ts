// Unit test for Trengo webhook signature verification (CLAUDE.md §11).
// Pins the real wire format: `Trengo-Signature: <timestamp>;<hash>`, where
// <hash> is the lowercase hex HMAC-SHA256 of `<timestamp>.<rawBody>`.

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { verifyAndParse } from './webhook'

const SECRET = 'whsec_trengo_unit'
const RAW = JSON.stringify({
  id: 'evt_1',
  event: 'message.inbound',
  occurred_at: '2026-06-06T10:00:00.000Z',
  data: { ticket_id: 1, contact: { phone: '+447700900123' } },
})

function trengoSig(
  rawBody: string,
  secret = SECRET,
  timestamp = '1700000000',
): string {
  const hash = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
  return `${timestamp};${hash}`
}

describe('verifyAndParse (Trengo)', () => {
  it('accepts a correctly-signed <timestamp>;<hash> payload', () => {
    const res = verifyAndParse(RAW, trengoSig(RAW), { webhookSecret: SECRET })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.envelope.id).toBe('evt_1')
  })

  it('rejects when the body is tampered after signing', () => {
    const sig = trengoSig(RAW)
    const tampered = RAW.replace('+447700900123', '+447700900999')
    expect(verifyAndParse(tampered, sig, { webhookSecret: SECRET }).ok).toBe(false)
  })

  it('rejects the legacy "hash of body only" shape (no timestamp prefix)', () => {
    const bare = createHmac('sha256', SECRET).update(RAW, 'utf8').digest('hex')
    expect(verifyAndParse(RAW, bare, { webhookSecret: SECRET }).ok).toBe(false)
  })

  it('rejects a signature made with the wrong secret', () => {
    const sig = trengoSig(RAW, 'whsec_wrong')
    expect(verifyAndParse(RAW, sig, { webhookSecret: SECRET }).ok).toBe(false)
  })

  it('rejects when the presented timestamp differs from the signed one', () => {
    // The timestamp is part of the signed material, so swapping it must fail.
    const hash = createHmac('sha256', SECRET)
      .update(`111.${RAW}`, 'utf8')
      .digest('hex')
    expect(verifyAndParse(RAW, `222;${hash}`, { webhookSecret: SECRET }).ok).toBe(
      false,
    )
  })

  it('rejects a missing or malformed signature', () => {
    expect(verifyAndParse(RAW, null, { webhookSecret: SECRET }).ok).toBe(false)
    expect(verifyAndParse(RAW, '', { webhookSecret: SECRET }).ok).toBe(false)
    expect(verifyAndParse(RAW, 'no-separator', { webhookSecret: SECRET }).ok).toBe(
      false,
    )
    expect(verifyAndParse(RAW, '1700000000;', { webhookSecret: SECRET }).ok).toBe(
      false,
    )
  })
})
