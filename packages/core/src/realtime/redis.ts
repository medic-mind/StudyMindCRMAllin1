// Redis pub/sub plumbing for the realtime bus (ADR 0020 Phase 7b).
//
// In single-instance Railway we publish through Node's in-process
// EventEmitter (bus.ts). When the deploy autoscales past one replica the
// in-process emit is no longer enough — instance B's SSE subscriber never
// hears instance A's publish. This module supplies the dependency-injected
// Redis publisher + subscriber the bus uses; lazy-initialised on first
// publish/subscribe so a test environment without REDIS_URL never touches
// the network.
//
// CLAUDE.md §3 (Redis on Railway is the locked stack choice) and §17
// (resilience: degrade gracefully — a Redis failure must not break the
// requesting path).

import type { Redis } from 'ioredis'

export const REDIS_CONVERSATION_CHANNEL = 'studymind:conversation.updated' as const

export interface RealtimeRedisFactory {
  /** Create the publisher client. ioredis lazy-connects on first command. */
  createPublisher(url: string): Redis
  /** Create the subscriber client. Same connection profile, separate client
   *  because ioredis (like all Redis clients) forbids mixing pub/sub and
   *  data commands on a single connection. */
  createSubscriber(url: string): Redis
}

/**
 * Default factory: dynamically imports ioredis so test files that mock the
 * bus can still load this module without bringing in the SDK.
 */
export const defaultRedisFactory: RealtimeRedisFactory = {
  createPublisher(url: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RedisCtor = require('ioredis') as typeof import('ioredis').default
    return new RedisCtor(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 3,
      // Don't crash the process on first connect — log via the listener and
      // let the publishing path fall through to local emit.
      enableOfflineQueue: false,
    })
  },
  createSubscriber(url: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RedisCtor = require('ioredis') as typeof import('ioredis').default
    return new RedisCtor(url, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    })
  },
}
