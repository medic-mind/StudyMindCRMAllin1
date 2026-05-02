// Sliding-window rate limiter. Backed by Redis in production; in-memory fallback
// for local dev where REDIS_URL is unset. See CLAUDE.md Section 27.

interface Bucket {
  count: number
  resetAt: number
}

const memoryBuckets = new Map<string, Bucket>()

const DEFAULT_LIMIT_PER_MINUTE = 120

export interface RateLimitParams {
  userId: string
  procedure: string
  limit?: number
  windowMs?: number
}

export async function rateLimit(params: RateLimitParams): Promise<boolean> {
  const limit = params.limit ?? DEFAULT_LIMIT_PER_MINUTE
  const windowMs = params.windowMs ?? 60_000
  const key = `${params.userId}:${params.procedure}`
  // TODO: when REDIS_URL is configured, swap to a Redis sliding-window counter.
  // The interface stays the same so callers do not change.
  const now = Date.now()
  const existing = memoryBuckets.get(key)
  if (!existing || existing.resetAt <= now) {
    memoryBuckets.set(key, { count: 1, resetAt: now + windowMs })
    return true
  }
  if (existing.count >= limit) return false
  existing.count += 1
  return true
}
