import { describe, expect, it } from 'vitest'

import { isSkippableSlackNoise } from './noise'

describe('isSkippableSlackNoise', () => {
  it('skips acks, reactions, emoji and bare links', () => {
    expect(isSkippableSlackNoise('ok')).toBe(true)
    expect(isSkippableSlackNoise('thanks!')).toBe(true)
    expect(isSkippableSlackNoise(':thumbsup:')).toBe(true)
    expect(isSkippableSlackNoise('🙏')).toBe(true)
    expect(isSkippableSlackNoise('<https://example.com/doc|the doc>')).toBe(true)
    expect(isSkippableSlackNoise('<@U123ABC> thanks')).toBe(true)
  })

  it('keeps anything with an email or phone-shaped digits', () => {
    expect(isSkippableSlackNoise('jane@example.com')).toBe(false)
    expect(isSkippableSlackNoise('call 07700 900123')).toBe(false)
    expect(isSkippableSlackNoise('+447700900123')).toBe(false)
  })

  it('keeps real sentences and name mentions', () => {
    expect(isSkippableSlackNoise('Jane paid')).toBe(false)
    expect(isSkippableSlackNoise('Jane Smith wants her invoice re-sent')).toBe(false)
    expect(isSkippableSlackNoise('chase Mr Patel about the UCAT course')).toBe(false)
  })

  it('keeps a bare name-shaped message (terse thread header) — it used to be a silent drop', () => {
    expect(isSkippableSlackNoise('Sampada')).toBe(false)
    expect(isSkippableSlackNoise('Sampada Neupane')).toBe(false)
    expect(isSkippableSlackNoise('O’Brien')).toBe(false)
  })

  it('capitalised acks/calendar words are still noise, not names', () => {
    expect(isSkippableSlackNoise('Thanks')).toBe(true)
    expect(isSkippableSlackNoise('Ok')).toBe(true)
    expect(isSkippableSlackNoise('Monday')).toBe(true)
    expect(isSkippableSlackNoise('UCAT')).toBe(true) // all-caps acronym
  })
})
