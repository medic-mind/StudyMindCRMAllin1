// Redis-backed fixed-window rate-limit counter (brief Phase 9/10; ADR 0020
// Phase 7b made Redis a first-class surface). The tRPC rate limiter calls
// this first and falls back to its in-memory store when this returns `null`
// (Redis not configured or unreachable) — degraded mode, never fail-closed
// on the hot path (CLAUDE.md §27).
//
// The window is a fixed bucket implemented with an atomic Lua INCR +
// first-write PEXPIRE, so a process crash can never leave a counter without
// a TTL (which would block a user indefinitely). The trade-off vs a true
// sliding window is a burst at a bucket boundary; acceptable for abuse
// protection and identical to the previous in-memory semantics.

import type { Redis } from 'ioredis'

/** Atomic: increment, and set the TTL only on the first write of the window. */
const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return c
`

let client: Redis | null = null
let initialised = false
let injected: Redis | null = null

/** Test seam — inject a fake ioredis client. Pair with `_resetForTests`. */
export function _setRedisClientForTests(fake: Redis | null): void {
  injected = fake
  initialised = false
  client = null
}

export function _resetForTests(): void {
  if (client) {
    try {
      client.disconnect()
    } catch {
      // best-effort
    }
  }
  client = null
  injected = null
  initialised = false
}

function getClient(): Redis | null {
  if (injected) return injected
  if (initialised) return client
  initialised = true
  const url = process.env['REDIS_URL']
  if (!url) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const RedisCtor = require('ioredis') as typeof import('ioredis').default
    client = new RedisCtor(url, {
      // Rate limiting is on the request hot path — fail fast and fall back to
      // memory rather than queueing commands against a dead connection.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    })
    client.on('error', (err) => {
      console.warn('[rate-limit] redis error', err)
    })
  } catch (err) {
    console.warn('[rate-limit] redis init failed', err)
    client = null
  }
  return client
}

export interface RedisRateLimitInput {
  /** Full bucket key — caller namespaces by (userId, procedure). */
  key: string
  windowSec: number
  max: number
}

/**
 * Returns:
 *   true  — under the limit, request allowed
 *   false — over the limit, reject
 *   null  — Redis unavailable; the caller must fall back to its local store
 */
export async function redisRateLimitAllow(
  input: RedisRateLimitInput,
): Promise<boolean | null> {
  const c = getClient()
  if (!c) return null
  try {
    const redisKey = `rl:${input.key}`
    const raw = await c.eval(
      FIXED_WINDOW_LUA,
      1,
      redisKey,
      String(input.windowSec * 1000),
    )
    const count = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(count)) return null
    return count <= input.max
  } catch (err) {
    // Connection dropped mid-request, Lua error, etc. Degrade to local.
    console.warn('[rate-limit] redis eval failed', err)
    return null
  }
}
