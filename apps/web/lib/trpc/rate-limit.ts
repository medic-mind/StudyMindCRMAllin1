// Fixed-window rate limiter. Backed by Redis in production (shared across
// Railway instances); in-memory fallback for local dev (and as a degraded-
// mode fallback when Redis is unreachable, per CLAUDE.md §27 "missing Redis
// falls through").
//
// Per-procedure limits live in `@studymind/core/auth/rate-limits`. The Redis
// counter lives in `@studymind/core/cache/redis-rate-limit`.

import { getRateLimit, type RateLimit } from '@studymind/core/auth/rate-limits'
import { redisRateLimitAllow } from '@studymind/core/cache/redis-rate-limit'

interface Bucket {
  count: number
  resetAt: number
}

const memoryBuckets = new Map<string, Bucket>()

export interface RateLimitParams {
  userId: string
  procedure: string
  /** Override the registered limit. Mostly for tests. */
  limit?: RateLimit
}

export async function rateLimit(params: RateLimitParams): Promise<boolean> {
  const limit = params.limit ?? getRateLimit(params.procedure)
  const key = `${params.userId}:${params.procedure}`

  // Prefer the shared Redis counter so the limit holds across instances.
  // `null` means Redis is not configured or unreachable — fall through to
  // the per-instance memory bucket. We never fail-closed on the hot path.
  const viaRedis = await redisRateLimitAllow({
    key,
    windowSec: limit.windowSec,
    max: limit.max,
  })
  if (viaRedis !== null) return viaRedis

  const windowMs = limit.windowSec * 1000
  const now = Date.now()
  const existing = memoryBuckets.get(key)
  if (!existing || existing.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (existing.count >= limit.max) return false
  existing.count += 1
  return true
}

/** Test helper. Resets the in-memory store so tests do not leak state. */
export function __resetRateLimitForTests(): void {
  memoryBuckets.clear()
}
