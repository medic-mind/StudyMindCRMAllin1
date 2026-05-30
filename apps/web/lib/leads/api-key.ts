// Lead-source API keys (ADR 0023). A per-website key authenticates the public
// POST /api/leads endpoint. We store only the sha256 + last 4 chars; the raw
// key is shown once at creation. Mirrors how we treat other secrets at rest.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const LEAD_KEY_PREFIX = 'sk_lead_'

export function generateLeadKey(): string {
  return `${LEAD_KEY_PREFIX}${randomBytes(24).toString('hex')}`
}

export function hashLeadKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

export function lastFour(key: string): string {
  return key.slice(-4)
}

/** Constant-time compare for the optional global master token fallback. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, Buffer.alloc(bufA.length))
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

/** Extract the presented key from Authorization, X-API-Key, or ?key=. */
export function extractPresentedKey(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim()
  const headerKey = req.headers.get('x-api-key')
  if (headerKey) return headerKey.trim()
  try {
    const url = new URL(req.url)
    const q = url.searchParams.get('key')
    if (q) return q.trim()
  } catch {
    // ignore
  }
  return null
}
