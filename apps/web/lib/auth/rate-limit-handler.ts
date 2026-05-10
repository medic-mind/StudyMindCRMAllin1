// Rate limiter for unauthenticated auth handlers (sign-up, forgot, verify-resend).
//
// The tRPC middleware in lib/trpc/rate-limit.ts is keyed on userId, which we
// don't have during sign-up / forgot-password. This is the same sliding-window
// primitive but keyed on (scope, identifier) so we can scope per-email and
// per-IP. CLAUDE.md §44.2 (controls).

interface Bucket {
  count: number
  resetAt: number
}

const memoryBuckets = new Map<string, Bucket>()

export interface AuthRateLimitParams {
  scope: string
  key: string
  limit?: number
  windowMs?: number
}

const DEFAULT_LIMIT = 5
const DEFAULT_WINDOW_MS = 15 * 60 * 1000

/**
 * Returns true when the call is allowed; false when the bucket is exhausted.
 * In-memory fallback only; swap to Redis when REDIS_URL is wired through
 * (same plan as lib/trpc/rate-limit.ts).
 */
export async function authRateLimit(params: AuthRateLimitParams): Promise<boolean> {
  const limit = params.limit ?? DEFAULT_LIMIT
  const windowMs = params.windowMs ?? DEFAULT_WINDOW_MS
  const key = `${params.scope}:${params.key}`
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

/** Test seam — clear the in-memory state. */
export function _resetAuthRateLimit(): void {
  memoryBuckets.clear()
}
