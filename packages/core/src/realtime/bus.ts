// Event bus for live updates (ADR 0020 Phase 3 + 7b).
//
// Single-instance Railway: subscribers register against a module-level
// EventEmitter and emits run synchronously in-process.
//
// Multi-instance Railway: when `REDIS_URL` is set, the bus lazy-initialises
// an ioredis publisher + subscriber pair. Local publish goes to Redis only;
// the Redis subscriber receives the published event (including ours) and
// re-emits to local listeners. Two-replica deploys see each other; the
// publishing instance also hears its own publish (idempotent — listeners
// are pure refetch hints; a duplicate hint is a wasted query, never a bug).
//
// Failure mode: a Redis connection failure logs to console and falls back
// to in-process emit so the requesting code path is never blocked
// (CLAUDE.md §17 — degrade gracefully on the hot path).

import { EventEmitter } from 'node:events'

import type { Redis } from 'ioredis'

import { defaultRedisFactory, REDIS_CONVERSATION_CHANNEL, type RealtimeRedisFactory } from './redis'

const emitter = new EventEmitter()
emitter.setMaxListeners(0)

export const REALTIME_EVENT_CONVERSATION_UPDATED = 'conversation.updated' as const

export interface ConversationUpdatedEvent {
  /** Conversation row id (cuid2). */
  id: string
  /** Trengo ticket id — keyed in case the client wants to ignore irrelevant
   *  conversations without a refetch round-trip. */
  trengoTicketId: number
  /** ISO timestamp the row's lastMessageAt was advanced to (or null when the
   *  upsert touched only metadata). */
  lastMessageAt: string | null
  /** Optional contactId so a per-contact subscriber can ignore unrelated
   *  conversations. */
  contactId: string | null
}

// -----------------------------------------------------------------------------
// Redis plumbing. Lazy-init; never connects when REDIS_URL is unset.
// -----------------------------------------------------------------------------

interface RedisState {
  publisher: Redis | null
  subscriber: Redis | null
  /** True once we have attempted init — guards against repeated init on every
   *  publish. Reset by `_resetForTests`. */
  initialised: boolean
  /** True when Redis is connected and ready to publish through. */
  ready: boolean
}

const state: RedisState = {
  publisher: null,
  subscriber: null,
  initialised: false,
  ready: false,
}

let factory: RealtimeRedisFactory = defaultRedisFactory

/** Test seam — swap the Redis factory so the bus can be exercised against a
 *  fake. Always pair with `_resetForTests` in a beforeEach so other tests do
 *  not inherit the override. */
export function _setRedisFactoryForTests(next: RealtimeRedisFactory): void {
  factory = next
  state.initialised = false
}

export function _resetForTests(): void {
  emitter.removeAllListeners()
  if (state.subscriber) {
    try {
      state.subscriber.disconnect()
    } catch {
      // ignore — best-effort cleanup
    }
  }
  if (state.publisher) {
    try {
      state.publisher.disconnect()
    } catch {
      // ignore
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
      // Log and continue — publishConversationUpdate falls back to local emit.
      console.warn('[realtime] redis publisher error', err)
      state.ready = false
    })
    state.subscriber.on('error', (err) => {
      console.warn('[realtime] redis subscriber error', err)
    })
    state.subscriber.on('message', (channel, payload) => {
      if (channel !== REDIS_CONVERSATION_CHANNEL) return
      try {
        const event = JSON.parse(payload) as ConversationUpdatedEvent
        emitter.emit(REALTIME_EVENT_CONVERSATION_UPDATED, event)
      } catch {
        // Malformed payload from a future writer — ignore.
      }
    })
    state.subscriber.subscribe(REDIS_CONVERSATION_CHANNEL).then(
      () => {
        state.ready = true
      },
      (err: unknown) => {
        console.warn('[realtime] redis subscribe failed', err)
        state.ready = false
      },
    )
  } catch (err) {
    // ioredis constructor throw, ENOTFOUND, etc — fall back to in-process.
    console.warn('[realtime] redis init failed', err)
    state.publisher = null
    state.subscriber = null
  }
}

// -----------------------------------------------------------------------------
// Public API — unchanged signatures from Phase 3.
// -----------------------------------------------------------------------------

export function publishConversationUpdate(event: ConversationUpdatedEvent): void {
  initRedisIfConfigured()
  if (state.publisher && state.ready) {
    // Publish via Redis — our own subscriber will receive it and emit
    // locally, so we do NOT also emit here (avoids double-dispatch).
    void state.publisher
      .publish(REDIS_CONVERSATION_CHANNEL, JSON.stringify(event))
      .catch((err: unknown) => {
        // Publish failed mid-flight — emit locally so this instance's
        // subscribers still see the event.
        console.warn('[realtime] redis publish failed', err)
        emitter.emit(REALTIME_EVENT_CONVERSATION_UPDATED, event)
      })
    return
  }
  emitter.emit(REALTIME_EVENT_CONVERSATION_UPDATED, event)
}

export type ConversationUpdatedListener = (event: ConversationUpdatedEvent) => void

export function subscribeConversationUpdates(
  listener: ConversationUpdatedListener,
): () => void {
  // Make sure Redis is wired before the first SSE connection so the
  // subscriber is already listening when its first event arrives.
  initRedisIfConfigured()
  emitter.on(REALTIME_EVENT_CONVERSATION_UPDATED, listener)
  return () => {
    emitter.off(REALTIME_EVENT_CONVERSATION_UPDATED, listener)
  }
}

/** Test-only — flushes every listener so a re-run starts clean. */
export function _clearAllSubscribers(): void {
  emitter.removeAllListeners()
}
