import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { logger } from '@studymind/core/logger'

import { buildCsp, generateNonce } from '@/lib/security/csp'

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
  '/api/webhooks/(.*)',
  // Inngest sync + invoke endpoints are authenticated by INNGEST_SIGNING_KEY,
  // not Clerk. Marking public lets the framework verify the signature itself.
  '/api/inngest(.*)',
])

// Paths we never log to keep Axiom signal-to-noise high.
function shouldSkipAccessLog(pathname: string): boolean {
  if (pathname === '/api/health') return true
  if (pathname.startsWith('/_next')) return true
  if (pathname.match(/\.[a-zA-Z0-9]{2,5}$/)) return true // static assets
  return false
}

const clerk = clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect()
  }
})

// Access-log wrapper. Records method, path, status, latency, requestId,
// actor_id (if signed in), user-agent. CLAUDE.md §25.
export default async function middleware(
  req: Parameters<typeof clerk>[0],
  evt: Parameters<typeof clerk>[1],
): Promise<NextResponse> {
  const start = Date.now()
  const requestId = req.headers.get('x-request-id') ?? cryptoRandomId()
  // Per-request CSP nonce. Strict CSP — no unsafe-inline (CLAUDE.md §44.2).
  // Clerk hosted forms / Sentry replay are allowlisted by host; any first
  // party script that needs to inline must read this nonce from `headers()`
  // server-side and emit `<script nonce={nonce}>`.
  const nonce = generateNonce()
  const csp = buildCsp(nonce)
  // Forward the nonce to RSC via a request header so layouts/pages can read
  // it through `headers()` and stamp <script> tags with nonce attributes.
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-csp-nonce', nonce)
  requestHeaders.set('x-request-id', requestId)

  const result = (await clerk(req, evt)) as NextResponse | undefined
  const res = result ?? NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set('x-request-id', requestId)
  res.headers.set('Content-Security-Policy', csp)
  const pathname = req.nextUrl.pathname
  if (!shouldSkipAccessLog(pathname)) {
    const actorId = req.headers.get('x-clerk-user-id') ?? null
    logger.info(
      {
        request_id: requestId,
        method: req.method,
        path: pathname,
        status: res.status,
        latency_ms: Date.now() - start,
        actor_id: actorId,
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
