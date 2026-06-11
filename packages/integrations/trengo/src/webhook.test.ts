// Unit test for Trengo webhook signature verification (CLAUDE.md §11).
// Pins the real wire format: `Trengo-Signature: <timestamp>;<hash>`, where
// <hash> is the lowercase hex HMAC-SHA256 of `<timestamp>.<rawBody>`.

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { coerceTrengoId, normaliseTrengoEvent } from './types'
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

// -----------------------------------------------------------------------------
// Inbound normalisation — event-name folding + id coercion. These are the
// quiet droppers: an unrecognised spelling skipped the event entirely, and a
// stringly ticket_id orphaned the message from its conversation head.
// -----------------------------------------------------------------------------

describe('normaliseTrengoEvent', () => {
  it('accepts canonical names directly', () => {
    expect(normaliseTrengoEvent('message.inbound')).toBe('message.inbound')
    expect(normaliseTrengoEvent('contact.updated')).toBe('contact.updated')
  })

  it('folds case and separators (workspace template spellings)', () => {
    expect(normaliseTrengoEvent('INBOUND_MESSAGE')).toBe('message.inbound')
    expect(normaliseTrengoEvent('Inbound message')).toBe('message.inbound')
    expect(normaliseTrengoEvent('OUTBOUND_MESSAGE')).toBe('message.outbound')
    expect(normaliseTrengoEvent('Message.Inbound')).toBe('message.inbound')
    expect(normaliseTrengoEvent('TICKET_CLOSED')).toBe('ticket.closed')
    expect(normaliseTrengoEvent('ticket-label-added')).toBe('label.added')
  })

  it('returns null for genuinely unknown events (fail closed on semantics)', () => {
    expect(normaliseTrengoEvent('voice.call_started')).toBeNull()
    expect(normaliseTrengoEvent('')).toBeNull()
  })
})

describe('coerceTrengoId', () => {
  it('passes numbers through and parses numeric strings', () => {
    expect(coerceTrengoId(12345)).toBe(12345)
    expect(coerceTrengoId('12345')).toBe(12345)
    expect(coerceTrengoId(' 678 ')).toBe(678)
  })

  it('rejects non-numeric shapes', () => {
    expect(coerceTrengoId('12a45')).toBeNull()
    expect(coerceTrengoId('')).toBeNull()
    expect(coerceTrengoId(null)).toBeNull()
    expect(coerceTrengoId(undefined)).toBeNull()
    expect(coerceTrengoId(Number.NaN)).toBeNull()
    expect(coerceTrengoId({ id: 1 })).toBeNull()
  })
})
