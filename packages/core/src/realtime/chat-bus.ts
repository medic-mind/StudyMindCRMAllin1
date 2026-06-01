// Realtime bus for internal team messaging (ADR 0022 — "make it feel alive").
//
// A deliberate sibling to `bus.ts` (the Trengo conversation bus): same
// in-process-EventEmitter + optional-Redis-fan-out shape, but a separate
// emitter and a separate Redis channel so the two never cross-talk and the
// conversation bus's tests stay untouched. Chat is high-volume and its own
// concern; keeping the wiring isolated means a change to one bus can never
// regress the other.
//
// Single-instance Railway: subscribers register against a module-level
// EventEmitter; publishes emit synchronously in-process.
// Multi-instance Railway (REDIS_URL set): publishes go out via Redis pub/sub
// and the local subscriber re-emits — so every replica's SSE connections see
// every message. Redis failure falls back to in-process emit (CLAUDE.md §17 —
// never block the hot path).
//
// Payload is a pure refetch *hint*: it carries just enough for a client to
// decide what to invalidate (and whether a mention is aimed at the viewer)
// without trusting the wire for state. The DB stays the source of truth.

import { EventEmitter } from 'node:events'

import type { Redis } from 'ioredis'

import { defaultRedisFactory, REDIS_CHAT_CHANNEL, type RealtimeRedisFactory } from './redis'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

export const REALTIME_EVENT_CHAT_ACTIVITY = 'chat.activity' as const

/** The kind of change that happened, so a client can scope its refetch. */
export type ChatActivityKind =
  | 'message'
  | 'edit'
  | 'delete'
  | 'reaction'
  | 'read'
  | 'pin'

export interface ChatActivityEvent {
  /** What happened — drives which queries the client invalidates. */
  kind: ChatActivityKind
  /** Channel the activity belongs to. */
  channelId: string
  /** Message id (cuid2). Null for channel-wide events like a read receipt. */
  messageId: string | null
  /** Thread root id when the activity is a threaded reply; null otherwise. */
  parentId: string | null
  /** Who caused it — lets a client skip self-authored events for notifications. */
  actorId: string
  /** Display name of the actor, for desktop-notification titles. */
  actorName: string | null
  /** Users @mentioned by this message — drives the per-user mention ping. */
  mentionUserIds: string[]
  /** One-line plain-text preview for the desktop notification. May be empty. */
  preview: string | null
  /** ISO timestamp the activity occurred. */
  occurredAt: string
}

// -----------------------------------------------------------------------------
// Redis plumbing. Lazy-init; never connects when REDIS_URL is unset. Mirrors
// bus.ts but on its own client pair + channel so the two buses are independent.
// -----------------------------------------------------------------------------

interface RedisState {
  publisher: Redis | null
  subscriber: Redis | null
  initialised: boolean
  ready: boolean
}

const state: RedisState = {
  publisher: null,
  subscriber: null,
  initialised: false,
  ready: false,
}

let factory: RealtimeRedisFactory = defaultRedisFactory

/** Test seam — swap the Redis factory. Pair with `_resetChatBusForTests`. */
export function _setChatRedisFactoryForTests(next: RealtimeRedisFactory): void {
  factory = next
  state.initialised = false
}

export function _resetChatBusForTests(): void {
  emitter.removeAllListeners()
  if (state.subscriber) {
    try {
      state.subscriber.disconnect()
    } catch {
      // best-effort
    }
  }
  if (state.publisher) {
    try {
      state.publisher.disconnect()
    } catch {
      // best-effort
    }
  }
  state.publisher = null
  state.subscriber = null
  state.initialised = false
  state.ready = false
  factory = defaultRedisFactory
}

function initRedisIfConfigured(): void {
  if (state.initialised) return
  state.initialised = true
  const url = process.env['REDIS_URL']
  if (!url) return
  try {
    state.publisher = factory.createPublisher(url)
    state.subscriber = factory.createSubscriber(url)
    state.publisher.on('error', (err) => {
      console.warn('[realtime/chat] redis publisher error', err)
      state.ready = false
    })
    state.subscriber.on('error', (err) => {
      console.warn('[realtime/chat] redis subscriber error', err)
    })
    state.subscriber.on('message', (channel, payload) => {
      if (channel !== REDIS_CHAT_CHANNEL) return
      try {
        const event = JSON.parse(payload) as ChatActivityEvent
        emitter.emit(REALTIME_EVENT_CHAT_ACTIVITY, event)
      } catch {
        // Malformed payload from a future writer — ignore.
      }
    })
    state.subscriber.subscribe(REDIS_CHAT_CHANNEL).then(
      () => {
        state.ready = true
      },
      (err: unknown) => {
        console.warn('[realtime/chat] redis subscribe failed', err)
        state.ready = false
      },
    )
  } catch (err) {
    console.warn('[realtime/chat] redis init failed', err)
    state.publisher = null
    state.subscriber = null
  }
}

// -----------------------------------------------------------------------------
// Public API.
// -----------------------------------------------------------------------------

export function publishChatActivity(event: ChatActivityEvent): void {
  initRedisIfConfigured()
  if (state.publisher && state.ready) {
    // Publish via Redis only — our own subscriber re-emits locally, so we do
    // NOT also emit here (avoids double-dispatch).
    void state.publisher
      .publish(REDIS_CHAT_CHANNEL, JSON.stringify(event))
      .catch((err: unknown) => {
        console.warn('[realtime/chat] redis publish failed', err)
        emitter.emit(REALTIME_EVENT_CHAT_ACTIVITY, event)
      })
    return
  }
  emitter.emit(REALTIME_EVENT_CHAT_ACTIVITY, event)
}

export type ChatActivityListener = (event: ChatActivityEvent) => void

export function subscribeChatActivity(listener: ChatActivityListener): () => void {
  initRedisIfConfigured()
  emitter.on(REALTIME_EVENT_CHAT_ACTIVITY, listener)
  return () => {
    emitter.off(REALTIME_EVENT_CHAT_ACTIVITY, listener)
  }
}

/** Test-only — flush every listener so a re-run starts clean. */
export function _clearChatSubscribers(): void {
  emitter.removeAllListeners()
}
