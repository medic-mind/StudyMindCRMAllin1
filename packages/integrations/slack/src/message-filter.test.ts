import { describe, expect, it } from 'vitest'

import { isIngestableSlackMessage } from './message-filter'

describe('isIngestableSlackMessage', () => {
  it('accepts a plain human message with text', () => {
    expect(isIngestableSlackMessage({ type: 'message', text: 'Spoke to the parent' })).toBe(true)
  })

  it('skips non-message events', () => {
    expect(isIngestableSlackMessage({ type: 'reaction_added' as 'message', text: 'x' })).toBe(false)
  })

  it('skips messages with no text', () => {
    expect(isIngestableSlackMessage({ type: 'message', text: '' })).toBe(false)
    expect(isIngestableSlackMessage({ type: 'message' })).toBe(false)
  })

  it('skips housekeeping/edit subtypes only', () => {
    expect(
      isIngestableSlackMessage({ type: 'message', text: 'edited', subtype: 'message_changed' }),
    ).toBe(false)
    expect(isIngestableSlackMessage({ type: 'message', text: 'hi', subtype: 'bot_message' })).toBe(
      false,
    )
    expect(
      isIngestableSlackMessage({ type: 'message', text: 'joined', subtype: 'channel_join' }),
    ).toBe(false)
  })

  it('INGESTS content-bearing subtypes — a call summary posted with an attachment', () => {
    // The team's summaries frequently carry a screenshot/recording, tagged
    // `file_share`; a blanket subtype reject silently dropped all of these
    // (audit-confirmed). thread_broadcast + me_message are content too.
    expect(
      isIngestableSlackMessage({
        type: 'message',
        text: '🇬🇧Aviral Sethi +447818953024 Medic Mind',
        subtype: 'file_share',
      }),
    ).toBe(true)
    expect(
      isIngestableSlackMessage({ type: 'message', text: 'reply', subtype: 'thread_broadcast' }),
    ).toBe(true)
    expect(isIngestableSlackMessage({ type: 'message', text: '/me waves', subtype: 'me_message' })).toBe(
      true,
    )
  })

  it('skips bot/app posts — including the CRM’s own #callsummaries announcements', () => {
    // The CRM's compulsory call-summary post (ADR 0039) carries the contact's
    // name/phone/email and WOULD match — the bot_id guard stops it duplicating.
    expect(
      isIngestableSlackMessage({
        type: 'message',
        text: 'Call completed — Jane Smith — +447700900123 — jane@example.com',
        bot_id: 'B0123',
      }),
    ).toBe(false)
    expect(isIngestableSlackMessage({ type: 'message', text: 'app post', app_id: 'A0123' })).toBe(
      false,
    )
  })
})
