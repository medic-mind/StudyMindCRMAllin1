// HTTP middleware. Auth gating returns in chunk 5 of ADR 0010 once
// Auth.js v5 is wired in. Until then this is a no-op pass-through that
// only enforces CSP, request id, and access logging.
//
// CLAUDE.md §25 (observability), §44.2 (CSP).

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { logger } from '@studymind/core/logger'

import { buildCsp, generateNonce } from '@/lib/security/csp'

// Paths we never log to keep Axiom signal-to-noise high.
function shouldSkipAccessLog(pathname: string): boolean {
  if (pathname === '/api/health') return true
  if (pathname.startsWith('/_next')) return true
  if (pathname.match(/\.[a-zA-Z0-9]{2,5}$/)) return true // static assets
  return false
}

export default async function middleware(req: NextRequest): Promise<NextResponse> {
  const start = Date.now()
  const requestId = req.headers.get('x-request-id') ?? cryptoRandomId()
  // Per-request CSP nonce. Strict CSP — no unsafe-inline (CLAUDE.md §44.2).
  const nonce = generateNonce()
  const csp = buildCsp(nonce)
  // Forward the nonce to RSC via a request header so layouts/pages can read
  // it through `headers()` and stamp <script> tags with nonce attributes.
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-csp-nonce', nonce)
  requestHeaders.set('x-request-id', requestId)

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set('x-request-id', requestId)
  res.headers.set('Content-Security-Policy', csp)
  const pathname = req.nextUrl.pathname
  if (!shouldSkipAccessLog(pathname)) {
    logger.info(
      {
        request_id: requestId,
        method: req.method,
        path: pathname,
        status: res.status,
        latency_ms: Date.now() - start,
        actor_id: null,
        user_agent: req.headers.get('user-agent'),
      },
      'http_access',
    )
  }
  return res
}

function cryptoRandomId(): string {
  // Edge runtime — Web Crypto. 16 hex chars is enough for log correlation.
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
}
