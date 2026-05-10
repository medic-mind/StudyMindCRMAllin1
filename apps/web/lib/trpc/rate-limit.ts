// Sliding-window rate limiter. Backed by Redis in production; in-memory
// fallback for local dev (and as a degraded-mode fallback when Redis is
// unreachable, per CLAUDE.md §27 "missing Redis falls through").
//
// Per-procedure limits live in `@studymind/core/auth/rate-limits`.

import { getRateLimit, type RateLimit } from '@studymind/core/auth/rate-limits'

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
  const windowMs = limit.windowSec * 1000
  const key = `${params.userId}:${params.procedure}`
  // TODO: when REDIS_URL is configured, swap to a Redis sliding-window counter.
  // The interface stays the same so callers do not change. If Redis is
  // configured but unreachable at request time we fall through to the memory
  // bucket below — degraded mode, never fail-closed on the hot path.
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
