// Webhook signature verification + money/enum mapping tests. Pure (no DB).

import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  mapClientType,
  mapCustomerCategory,
  mapEventSource,
  mapInvoiceStatus,
  toMajor,
  toMinor,
} from './types'
import { verifyAndParse } from './webhook'

const SECRET = 'whsec_test_abc123'

function sign(body: string, t: number, secret = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return `t=${t},v1=${v1}`
}

describe('verifyAndParse', () => {
  const body = JSON.stringify({
    id: 'evt_42',
    type: 'invoice.created',
    source: 'app',
    record: { id: 'inv_1' },
  })
  const now = 1_780_000_000_000 // fixed clock (ms)
  const t = Math.floor(now / 1000)

  it('accepts a valid signature and parses the envelope', () => {
    const result = verifyAndParse(body, sign(body, t), {
      webhookSecret: SECRET,
      nowMs: now,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.id).toBe('evt_42')
      expect(result.envelope.type).toBe('invoice.created')
      expect(result.envelope.source).toBe('app')
    }
  })

  it('rejects a missing signature', () => {
    const result = verifyAndParse(body, null, { webhookSecret: SECRET, nowMs: now })
    expect(result).toEqual({ ok: false, reason: 'missing_signature' })
  })

  it('rejects when no secret is configured', () => {
    const result = verifyAndParse(body, sign(body, t), { webhookSecret: null, nowMs: now })
    expect(result).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('rejects a tampered body (signature mismatch)', () => {
    const tampered = body.replace('inv_1', 'inv_HACKED')
    const result = verifyAndParse(tampered, sign(body, t), {
      webhookSecret: SECRET,
      nowMs: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a signature signed with the wrong secret', () => {
    const result = verifyAndParse(body, sign(body, t, 'whsec_wrong'), {
      webhookSecret: SECRET,
      nowMs: now,
    })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a timestamp outside the tolerance window (replay)', () => {
    const oldT = Math.floor(now / 1000) - 10 * 60 // 10 minutes ago
    const result = verifyAndParse(body, sign(body, oldT), {
      webhookSecret: SECRET,
      nowMs: now,
    })
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })

  it('rejects a malformed signature header', () => {
    const result = verifyAndParse(body, 'garbage', { webhookSecret: SECRET, nowMs: now })
    expect(result).toEqual({ ok: false, reason: 'malformed_signature' })
  })

  it('rejects a valid signature over a non-JSON body', () => {
    const notJson = 'not json at all'
    const result = verifyAndParse(notJson, sign(notJson, t), {
      webhookSecret: SECRET,
      nowMs: now,
    })
    expect(result).toEqual({ ok: false, reason: 'invalid_body' })
  })
})

describe('money helpers', () => {
  it('converts decimal strings to integer minor units', () => {
    expect(toMinor('720.00')).toBe(72000)
    expect(toMinor('0.01')).toBe(1)
    expect(toMinor('100')).toBe(10000)
    expect(toMinor('19.99')).toBe(1999)
    expect(toMinor('1.5')).toBe(150)
  })

  it('converts numbers to integer minor units without float drift', () => {
    expect(toMinor(720)).toBe(72000)
    // 19.99 * 100 in float is 1998.9999…; our parser avoids that.
    expect(toMinor(19.99)).toBe(1999)
    expect(toMinor(0.1 + 0.2)).toBe(30) // 0.30000000000000004 → "0.30"
  })

  it('handles null / empty as zero', () => {
    expect(toMinor(null)).toBe(0)
    expect(toMinor(undefined)).toBe(0)
    expect(toMinor('')).toBe(0)
  })

  it('round-trips minor → major', () => {
    expect(toMajor(72000)).toBe(720)
    expect(toMajor(1999)).toBe(19.99)
    expect(toMajor(1)).toBe(0.01)
  })
})

describe('enum mapping (fail closed)', () => {
  it('maps known customer categories and fails closed on unknown', () => {
    expect(mapCustomerCategory('b2b')).toBe('b2b')
    expect(mapCustomerCategory('b2c')).toBe('b2c')
    expect(mapCustomerCategory('alt_provision')).toBe('alt_provision')
    expect(mapCustomerCategory('martian')).toBe('unknown')
    expect(mapCustomerCategory(null)).toBe('unknown')
  })

  it('maps invoice statuses and fails closed', () => {
    expect(mapInvoiceStatus('paid')).toBe('paid')
    expect(mapInvoiceStatus('partially_paid')).toBe('partially_paid')
    expect(mapInvoiceStatus('something_new')).toBe('unknown')
  })

  it('maps client types and fails closed', () => {
    expect(mapClientType('international')).toBe('international')
    expect(mapClientType('weird')).toBe('unknown')
  })

  it('maps event source, defaulting unknown', () => {
    expect(mapEventSource('api')).toBe('api')
    expect(mapEventSource('app')).toBe('app')
    expect(mapEventSource('system')).toBe('system')
    expect(mapEventSource('other')).toBe('unknown')
  })
})
