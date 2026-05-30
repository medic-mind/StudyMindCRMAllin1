// Tests for the conversation-head backfill row mapper. CLAUDE.md §11.

import { describe, expect, it } from 'vitest'

import {
  dbTypeToEventName,
  rowToInput,
  type InteractionRow,
} from './backfill-conversation-heads'

function row(partial: Partial<InteractionRow>): InteractionRow {
  return {
    id: 'i_1',
    type: 'message',
    occurredAt: new Date('2026-05-30T10:00:00Z'),
    contactId: null,
    familyId: null,
    payload: {},
    ...partial,
  }
}

describe('dbTypeToEventName', () => {
  it('maps message + interactionType to inbound or outbound', () => {
    expect(dbTypeToEventName('message', { interactionType: 'message.inbound' })).toBe(
      'message.inbound',
    )
    expect(dbTypeToEventName('message', { interactionType: 'message.outbound' })).toBe(
      'message.outbound',
    )
  })

  it('defaults message with no interactionType marker to inbound', () => {
    // Historic rows pre-dating the marker — treat them as inbound (the
    // common case). Outbound was rarer and required a connected token.
    expect(dbTypeToEventName('message', {})).toBe('message.inbound')
  })

  it('maps ticket / label types directly to their dotted names', () => {
    expect(dbTypeToEventName('ticket_assigned', {})).toBe('ticket.assigned')
    expect(dbTypeToEventName('ticket_closed', {})).toBe('ticket.closed')
    expect(dbTypeToEventName('ticket_reopened', {})).toBe('ticket.reopened')
    expect(dbTypeToEventName('label_added', {})).toBe('label.added')
    expect(dbTypeToEventName('label_removed', {})).toBe('label.removed')
  })

  it('returns null for types it cannot replay', () => {
    expect(dbTypeToEventName('note', {})).toBe(null)
    expect(dbTypeToEventName('email_received', {})).toBe(null)
  })
})

describe('rowToInput', () => {
  it('skips rows without a numeric ticketId', () => {
    expect(rowToInput(row({ payload: { channel: 'whatsapp' } }))).toBe(null)
    // String ticketId is intentionally treated as missing — the head is keyed
    // on a Prisma Int.
    expect(rowToInput(row({ payload: { ticketId: '7', channel: 'sms' } }))).toBe(null)
  })

  it('returns a replayable input for a recognised inbound message', () => {
    const out = rowToInput(
      row({
        type: 'message',
        contactId: 'c_1',
        payload: {
          ticketId: 99,
          channel: 'whatsapp',
          interactionType: 'message.inbound',
        },
      }),
    )
    expect(out).toMatchObject({
      ticketId: 99,
      eventName: 'message.inbound',
      channel: 'whatsapp',
      contactId: 'c_1',
    })
  })

  it('extracts a label name from either the object or string payload shape', () => {
    const fromObject = rowToInput(
      row({
        type: 'label_added',
        payload: { ticketId: 1, label: { id: 7, name: 'urgent' } },
      }),
    )
    expect(fromObject?.label).toBe('urgent')

    const fromString = rowToInput(
      row({ type: 'label_added', payload: { ticketId: 1, label: 'vip' } }),
    )
    expect(fromString?.label).toBe('vip')
  })

  it('accepts assigneeId or trengoAssigneeId on a ticket.assigned row', () => {
    const fromAssigneeId = rowToInput(
      row({
        type: 'ticket_assigned',
        payload: { ticketId: 1, assigneeId: 42 },
      }),
    )
    expect(fromAssigneeId?.trengoAssigneeId).toBe(42)

    const fromTrengoAssigneeId = rowToInput(
      row({
        type: 'ticket_assigned',
        payload: { ticketId: 1, trengoAssigneeId: 99 },
      }),
    )
    expect(fromTrengoAssigneeId?.trengoAssigneeId).toBe(99)
  })

  it('drops unknown channels rather than passing them through', () => {
    const out = rowToInput(
      row({
        type: 'message',
        payload: { ticketId: 1, channel: 'telegram' },
      }),
    )
    expect(out?.channel).toBe(null)
  })
})
