// Tests for the in-process realtime bus. ADR 0020 Phase 3.

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  _clearAllSubscribers,
  publishConversationUpdate,
  subscribeConversationUpdates,
  type ConversationUpdatedEvent,
} from './bus'

afterEach(() => {
  _clearAllSubscribers()
})

const sample: ConversationUpdatedEvent = {
  id: 'conv_1',
  trengoTicketId: 42,
  lastMessageAt: '2026-05-30T10:00:00.000Z',
  contactId: 'c_1',
}

describe('realtime bus', () => {
  it('delivers published events to every active subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeConversationUpdates(a)
    subscribeConversationUpdates(b)
    publishConversationUpdate(sample)
    expect(a).toHaveBeenCalledWith(sample)
    expect(b).toHaveBeenCalledWith(sample)
  })

  it('unsubscribe stops delivery to that listener but not others', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribeConversationUpdates(a)
    subscribeConversationUpdates(b)
    unsubA()
    publishConversationUpdate(sample)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith(sample)
  })

  it('handles zero subscribers without throwing', () => {
    expect(() => publishConversationUpdate(sample)).not.toThrow()
  })
})
