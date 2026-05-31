// Tests for the internal team-messaging realtime bus (ADR 0022). Mirrors the
// conversation bus tests but against the isolated chat emitter + channel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Redis } from 'ioredis'

import {
  _clearChatSubscribers,
  _resetChatBusForTests,
  _setChatRedisFactoryForTests,
  publishChatActivity,
  REALTIME_EVENT_CHAT_ACTIVITY,
  subscribeChatActivity,
  type ChatActivityEvent,
} from './chat-bus'
import { REDIS_CHAT_CHANNEL } from './redis'

afterEach(() => {
  _resetChatBusForTests()
  delete process.env['REDIS_URL']
})

const sample: ChatActivityEvent = {
  kind: 'message',
  channelId: 'chan_1',
  messageId: 'msg_1',
  parentId: null,
  actorId: 'u_1',
  actorName: 'Alex Doe',
  mentionUserIds: ['u_2'],
  preview: 'hello team',
  occurredAt: '2026-06-03T10:00:00.000Z',
}

describe('chat bus — in-process (no REDIS_URL)', () => {
  it('delivers published activity to every active subscriber', () => {
    const a = vi.fn()
    const b = vi.fn()
    subscribeChatActivity(a)
    subscribeChatActivity(b)
    publishChatActivity(sample)
    expect(a).toHaveBeenCalledWith(sample)
    expect(b).toHaveBeenCalledWith(sample)
  })

  it('unsubscribe stops delivery to that listener but not others', () => {
    const a = vi.fn()
    const b = vi.fn()
    const unsubA = subscribeChatActivity(a)
    subscribeChatActivity(b)
    unsubA()
    publishChatActivity(sample)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledWith(sample)
  })

  it('handles zero subscribers without throwing', () => {
    expect(() => publishChatActivity(sample)).not.toThrow()
    _clearChatSubscribers()
  })
})

describe('chat bus — Redis pub/sub (REDIS_URL set)', () => {
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

  it('subscribes to the chat channel on first publish', async () => {
    const fake = buildFakeRedisFactory()
    _setChatRedisFactoryForTests(fake.factory)
    publishChatActivity(sample)
    await new Promise((r) => setImmediate(r))
    expect(fake.subscribedChannel).toBe(REDIS_CHAT_CHANNEL)
  })

  it('round-trips an event through Redis to a local subscriber', async () => {
    const fake = buildFakeRedisFactory()
    _setChatRedisFactoryForTests(fake.factory)
    const listener = vi.fn()
    subscribeChatActivity(listener)
    await new Promise((r) => setImmediate(r))
    publishChatActivity(sample)
    await new Promise((r) => setImmediate(r))
    expect(fake.publishedMessages).toHaveLength(1)
    expect(fake.publishedMessages[0]?.channel).toBe(REDIS_CHAT_CHANNEL)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(sample)
  })

  it('does not double-dispatch when Redis is publishing', async () => {
    const fake = buildFakeRedisFactory()
    _setChatRedisFactoryForTests(fake.factory)
    const listener = vi.fn()
    subscribeChatActivity(listener)
    await new Promise((r) => setImmediate(r))
    publishChatActivity(sample)
    await new Promise((r) => setImmediate(r))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(REALTIME_EVENT_CHAT_ACTIVITY).toBe('chat.activity')
  })
})
