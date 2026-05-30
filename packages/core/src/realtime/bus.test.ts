// Tests for the in-process realtime bus. ADR 0020 Phase 3 + 7b.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Redis } from 'ioredis'

import {
  _clearAllSubscribers,
  _resetForTests,
  _setRedisFactoryForTests,
  publishConversationUpdate,
  REALTIME_EVENT_CONVERSATION_UPDATED,
  subscribeConversationUpdates,
  type ConversationUpdatedEvent,
} from './bus'
import { REDIS_CONVERSATION_CHANNEL } from './redis'

afterEach(() => {
  _resetForTests()
  delete process.env['REDIS_URL']
})

const sample: ConversationUpdatedEvent = {
  id: 'conv_1',
  trengoTicketId: 42,
  lastMessageAt: '2026-05-30T10:00:00.000Z',
  contactId: 'c_1',
}

describe('realtime bus — in-process (no REDIS_URL)', () => {
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
    _clearAllSubscribers()
  })
})

describe('realtime bus — Redis pub/sub (REDIS_URL set)', () => {
  /** Minimal fake that captures publish calls and lets the test simulate
   *  the Redis subscriber receiving a published message. */
  function buildFakeRedisFactory() {
    const publishedMessages: Array<{ channel: string; payload: string }> = []
    let subscribedChannel: string | null = null
    const messageHandlers: Array<(channel: string, payload: string) => void> = []

    const subscriber = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'message') {
          messageHandlers.push(handler as (channel: string, payload: string) => void)
        }
      }),
      subscribe: vi.fn(async (channel: string) => {
        subscribedChannel = channel
      }),
      disconnect: vi.fn(),
    } as unknown as Redis

    const publisher = {
      on: vi.fn(),
      publish: vi.fn(async (channel: string, payload: string) => {
        publishedMessages.push({ channel, payload })
        // Simulate the round-trip — Redis would deliver the published
        // message to every subscriber on that channel, including our own.
        if (channel === subscribedChannel) {
          for (const handler of messageHandlers) {
            handler(channel, payload)
          }
        }
        return 1
      }),
      disconnect: vi.fn(),
    } as unknown as Redis

    return {
      factory: {
        createPublisher: () => publisher,
        createSubscriber: () => subscriber,
      },
      publishedMessages,
      get subscribedChannel() {
        return subscribedChannel
      },
    }
  }

  beforeEach(() => {
    process.env['REDIS_URL'] = 'redis://localhost:6379'
  })

  it('subscribes to the conversation channel on first publish', async () => {
    const fake = buildFakeRedisFactory()
    _setRedisFactoryForTests(fake.factory)
    publishConversationUpdate(sample)
    // Allow the subscribe promise to resolve so `state.ready` flips before
    // we assert. The first publish is buffered through Redis lazily — for
    // this assertion we only care that subscribe was called for the right
    // channel.
    await new Promise((r) => setImmediate(r))
    expect(fake.subscribedChannel).toBe(REDIS_CONVERSATION_CHANNEL)
  })

  it('round-trips an event through Redis to a local subscriber', async () => {
    const fake = buildFakeRedisFactory()
    _setRedisFactoryForTests(fake.factory)
    const listener = vi.fn()
    subscribeConversationUpdates(listener)
    // Give the bus's lazy `subscribe()` promise a tick so `state.ready` is
    // true before we publish — otherwise the first publish goes local-only.
    await new Promise((r) => setImmediate(r))
    publishConversationUpdate(sample)
    // The publish path is async (publisher.publish returns a promise);
    // await one tick to let the simulated round-trip deliver.
    await new Promise((r) => setImmediate(r))
    expect(fake.publishedMessages).toHaveLength(1)
    expect(fake.publishedMessages[0]?.channel).toBe(REDIS_CONVERSATION_CHANNEL)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(sample)
  })

  it(
    'does not emit locally directly when Redis is publishing (no double-dispatch)',
    async () => {
      const fake = buildFakeRedisFactory()
      _setRedisFactoryForTests(fake.factory)
      const listener = vi.fn()
      subscribeConversationUpdates(listener)
      await new Promise((r) => setImmediate(r))
      publishConversationUpdate(sample)
      await new Promise((r) => setImmediate(r))
      // Exactly once — via the Redis round-trip. If we emitted locally too
      // we would have observed two calls.
      expect(listener).toHaveBeenCalledTimes(1)
      expect(REALTIME_EVENT_CONVERSATION_UPDATED).toBe('conversation.updated')
    },
  )
})
