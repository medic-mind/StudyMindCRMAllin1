import { describe, expect, it } from 'vitest'

import {
  isGoogleVoiceSender,
  normaliseToE164,
  parseGoogleVoiceNotification,
} from './google-voice'

describe('isGoogleVoiceSender', () => {
  it('matches the Google Voice notifier address', () => {
    expect(isGoogleVoiceSender(['someone@studymind.co.uk', 'voice-noreply@google.com'])).toBe(
      true,
    )
  })
  it('is false for ordinary senders', () => {
    expect(isGoogleVoiceSender(['parent@example.com'])).toBe(false)
  })
})

describe('normaliseToE164', () => {
  it('keeps an existing + number, stripping separators', () => {
    expect(normaliseToE164('+44 7911 123456')).toBe('+447911123456')
  })
  it('prefixes a 10-digit NANP number with +1', () => {
    expect(normaliseToE164('(555) 123-4567')).toBe('+15551234567')
  })
  it('handles an 11-digit leading-1 number', () => {
    expect(normaliseToE164('1 555 123 4567')).toBe('+15551234567')
  })
  it('returns null when it cannot be sure', () => {
    expect(normaliseToE164('07911 123')).toBeNull()
    expect(normaliseToE164(null)).toBeNull()
  })
})

describe('parseGoogleVoiceNotification', () => {
  it('parses a voicemail with a name + number and keeps the transcript', () => {
    const r = parseGoogleVoiceNotification({
      subject: 'New voicemail from John Smith (555) 123-4567',
      bodyText: 'Hi, this is John calling about tutoring. Please call me back.',
    })
    expect(r.kind).toBe('voicemail')
    expect(r.counterpartyName).toBe('John Smith')
    expect(r.phoneE164).toBe('+15551234567')
    expect(r.content).toContain('tutoring')
  })

  it('parses a missed call with no transcript', () => {
    const r = parseGoogleVoiceNotification({
      subject: 'Missed call from (555) 123-4567 at 2:14 PM',
      bodyText: 'You have a missed call.',
    })
    expect(r.kind).toBe('missed_call')
    expect(r.counterpartyName).toBeNull()
    expect(r.phoneE164).toBe('+15551234567')
    expect(r.content).toBeNull()
  })

  it('parses a text message', () => {
    const r = parseGoogleVoiceNotification({
      subject: 'New text message from Jane Doe',
      bodyText: 'Can we move the lesson to Thursday? — from +1 (555) 987-6543',
    })
    expect(r.kind).toBe('text')
    expect(r.counterpartyName).toBe('Jane Doe')
    expect(r.phoneE164).toBe('+15559876543')
    expect(r.content).toContain('Thursday')
  })

  it('falls back to unknown for an unrecognised subject', () => {
    const r = parseGoogleVoiceNotification({
      subject: 'Your Google Voice account',
      bodyText: 'Settings changed.',
    })
    expect(r.kind).toBe('unknown')
  })
})
