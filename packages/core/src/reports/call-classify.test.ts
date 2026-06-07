import { describe, expect, it } from 'vitest'

import { classifyStoredCall, readAircallCallId } from './call-classify'

describe('readAircallCallId', () => {
  it('accepts a numeric Aircall id (the real shape both writers persist)', () => {
    expect(readAircallCallId(123456789)).toBe('123456789')
  })

  it('accepts a string id', () => {
    expect(readAircallCallId('call_abc')).toBe('call_abc')
  })

  it('rejects null / undefined / empty / NaN', () => {
    expect(readAircallCallId(undefined)).toBeNull()
    expect(readAircallCallId(null)).toBeNull()
    expect(readAircallCallId('')).toBeNull()
    expect(readAircallCallId(Number.NaN)).toBeNull()
  })
})

describe('classifyStoredCall', () => {
  const t = new Date('2026-06-01T10:00:00.000Z')

  it('classifies a numeric-id call as aircall', () => {
    expect(classifyStoredCall({ aircallCallId: 42 }, t).provider).toBe('aircall')
  })

  it('dedupes the lifecycle events of ONE call onto a single key', () => {
    // The webhook writes a row per event with a DIFFERENT occurredAt; they
    // must share a dedupe key, otherwise one call is counted many times and
    // its duration-0 events inflate the "missed" count. This is the 133-vs-52
    // glitch.
    const created = classifyStoredCall(
      { aircallCallId: 42, interactionType: 'call.created' },
      new Date('2026-06-01T10:00:00Z'),
    )
    const ended = classifyStoredCall(
      { aircallCallId: 42, interactionType: 'call.ended' },
      new Date('2026-06-01T10:03:00Z'),
    )
    expect(created.callId).toBe('42')
    expect(ended.callId).toBe('42')
  })

  it('honours an explicit provider tag (google_voice / manual)', () => {
    expect(classifyStoredCall({ provider: 'google_voice' }, t).provider).toBe('google_voice')
    expect(classifyStoredCall({ provider: 'manual', aircallCallId: 7 }, t).provider).toBe('manual')
  })

  it('falls back to a timestamp key for an id-less manual call', () => {
    const c = classifyStoredCall({}, t)
    expect(c.provider).toBe('manual')
    expect(c.aircallId).toBeNull()
    expect(c.callId).toBe('manual:2026-06-01T10:00:00.000Z')
  })
})
