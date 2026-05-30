// Tests for the shared Trengo conversation resolver. CLAUDE.md §11.

import { describe, expect, it } from 'vitest'

import { resolveActiveTrengoConversation, type ConversationDb } from './conversations'

function dbWith(rows: Array<{ payload: unknown }>): ConversationDb {
  return {
    interaction: {
      findMany: async () => rows,
    },
  } as unknown as ConversationDb
}

describe('resolveActiveTrengoConversation', () => {
  it('returns the newest ticket + channel', async () => {
    const conv = await resolveActiveTrengoConversation(
      dbWith([
        { payload: { ticketId: 99, channel: 'whatsapp' } },
        { payload: { ticketId: 1, channel: 'sms' } },
      ]),
      'c_1',
    )
    expect(conv).toEqual({ ticketId: 99, channel: 'whatsapp' })
  })

  it('skips rows without a numeric ticketId and finds the next valid one', async () => {
    const conv = await resolveActiveTrengoConversation(
      dbWith([
        { payload: { channel: 'whatsapp' } }, // no ticketId
        { payload: { ticketId: '7', channel: 'sms' } }, // string ticketId is ignored
        { payload: { ticketId: 7, channel: 'sms' } }, // valid
      ]),
      'c_1',
    )
    expect(conv).toEqual({ ticketId: 7, channel: 'sms' })
  })

  it('rejects unknown channels', async () => {
    const conv = await resolveActiveTrengoConversation(
      dbWith([{ payload: { ticketId: 7, channel: 'telegram' } }]),
      'c_1',
    )
    expect(conv).toBeNull()
  })

  it('returns null when the contact has no Trengo messages', async () => {
    const conv = await resolveActiveTrengoConversation(dbWith([]), 'c_1')
    expect(conv).toBeNull()
  })
})
