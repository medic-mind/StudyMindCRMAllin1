import { describe, expect, it } from 'vitest'

import type { InteractionListItem } from '@studymind/core/interaction'

import { collapseTimeline, formatDuration, timelineBucket, timelineLabel } from './timeline'

function item(over: Partial<InteractionListItem>): InteractionListItem {
  return {
    id: Math.random().toString(36).slice(2),
    type: 'note',
    occurredAt: new Date('2026-06-11T00:20:00Z'),
    summary: 'x',
    authorId: null,
    contactId: 'c1',
    familyId: null,
    ...over,
  }
}

describe('timelineLabel', () => {
  it('labels a real call with direction + duration — never as a note', () => {
    const l = timelineLabel(
      item({
        type: 'call',
        meta: {
          channel: null,
          direction: 'inbound',
          durationSec: 130,
          status: null,
          error: null,
          source: null,
        },
      }),
    )
    expect(l.label).toBe('Inbound call · 2m 10s')
    expect(l.tone).toBe('call')
  })

  it('tags a Google Voice call so it reads as non-Aircall', () => {
    const l = timelineLabel(
      item({
        type: 'call',
        meta: {
          channel: null,
          direction: 'inbound',
          durationSec: 0,
          status: null,
          error: null,
          source: 'google_voice',
        },
      }),
    )
    expect(l.label).toBe('Inbound call · Google Voice')
  })

  it('labels a WhatsApp message by channel', () => {
    const l = timelineLabel(
      item({
        type: 'message',
        meta: {
          channel: 'whatsapp',
          direction: null,
          durationSec: null,
          status: 'sent',
          error: null,
          source: null,
        },
      }),
    )
    expect(l.label).toBe('WhatsApp message')
  })

  it('keeps card events distinct from calls (quick-action "Call Completed" is a card event)', () => {
    expect(timelineLabel(item({ type: 'card_moved' })).label).toBe('Card moved')
    expect(timelineLabel(item({ type: 'card_comment' })).label).toBe('Card comment')
  })

  it('falls back to a readable label for unmapped types', () => {
    expect(timelineLabel(item({ type: 'family.billing_contact_changed' })).label).toBe(
      'Family billing contact changed',
    )
  })
})

describe('collapseTimeline', () => {
  it('folds consecutive identical rows into one entry with a count', () => {
    const rows = [
      item({ type: 'note', summary: 'Call completed.' }),
      item({ type: 'note', summary: 'Call completed.' }),
      item({ type: 'note', summary: 'Call completed.' }),
      item({ type: 'note', summary: 'Different note' }),
      item({ type: 'note', summary: 'Call completed.' }),
    ]
    const collapsed = collapseTimeline(rows)
    expect(collapsed.map((c) => c.count)).toEqual([3, 1, 1])
    expect(collapsed[0]!.item.summary).toBe('Call completed.')
  })

  it('never folds across different types even with the same summary', () => {
    const rows = [
      item({ type: 'note', summary: 'Call completed.' }),
      item({ type: 'card_comment', summary: 'Call completed.' }),
    ]
    expect(collapseTimeline(rows)).toHaveLength(2)
  })

  it('passes empty input through', () => {
    expect(collapseTimeline([])).toEqual([])
  })
})

describe('buckets + duration', () => {
  it('buckets types for the filter chips', () => {
    expect(timelineBucket('call')).toBe('calls')
    expect(timelineBucket('message')).toBe('messages')
    expect(timelineBucket('email_received')).toBe('emails')
    expect(timelineBucket('card_moved')).toBe('cards')
    expect(timelineBucket('note')).toBe('notes')
    expect(timelineBucket('payment')).toBe('other')
  })

  it('formats durations sensibly', () => {
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(60)).toBe('1m')
    expect(formatDuration(130)).toBe('2m 10s')
  })
})
