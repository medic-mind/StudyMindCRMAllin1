// HTTP middleware. ADR 0010 chunk 5: real auth gate via NextAuth v5.
//
// We use an edge-safe NextAuth config (lib/auth/edge-config) because the
// full config pulls Prisma + bcrypt which the Edge runtime cannot run.
// The JWT cookie carries everything middleware needs.
//
// Public paths bypass the session check (sign-in, password reset, webhooks,
// healthcheck, OAuth callbacks). Everything else redirects to /sign-in.
// CLAUDE.md §25 (observability), §44.2 (CSP).

import NextAuth from 'next-auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

import { logger } from '@studymind/core/logger/edge'

import { authEdgeConfig } from '@/lib/auth/edge-config'
import { buildCsp, generateNonce } from '@/lib/security/csp'

const { auth: authMiddleware } = NextAuth(authEdgeConfig)

const PUBLIC_PATH_PREFIXES = [
  '/sign-in',
  '/sign-up',
  '/verify',
  '/verify-email-sent',
  '/forgot',
  '/reset',
  '/auth/error',
  '/api/auth',
  '/api/webhooks',
  '/api/oauth/gmail/callback',
  '/api/health',
  '/_next',
]

function isPublicPath(pathname: string): boolean {
  // The root '/' is NOT public — unauthenticated visitors must be redirected
  // to /sign-in so they don't see the (app) shell.
  if (
    PUBLIC_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  ) {
    return true
  }
  if (/\.[a-zA-Z0-9]{2,5}$/.test(pathname)) return true
  return false
}

function shouldSkipAccessLog(pathname: string): boolean {
  if (pathname === '/api/health') return true
  if (pathname.startsWith('/_next')) return true
  if (pathname.match(/\.[a-zA-Z0-9]{2,5}$/)) return true
  return false
}

export default authMiddleware((req) => {
  const start = Date.now()
  const requestId = req.headers.get('x-request-id') ?? cryptoRandomId()
  const nonce = generateNonce()
  const csp = buildCsp(nonce)
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-csp-nonce', nonce)
  requestHeaders.set('x-request-id', requestId)

  const pathname = req.nextUrl.pathname
  const session = req.auth as
    | {
        user?: {
          id: string
          mustResetPassword?: boolean
          totpEnabledAt?: string | null
          roles?: string[]
          role?: string
        }
      }
    | null

  if (!session && !isPublicPath(pathname)) {
    const signInUrl = new URL('/sign-in', req.nextUrl.origin)
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search)
    return NextResponse.redirect(signInUrl)
  }

  // Force-reset gate: a user holding mustResetPassword can only reach the
  // change-password page and the sign-out path. ADR 0010, chunk 7.
  if (
    session?.user?.mustResetPassword &&
    !isPublicPath(pathname) &&
    pathname !== '/account/change-password' &&
    pathname !== '/api/auth/signout' &&
    !pathname.startsWith('/api/auth/')
  ) {
    return NextResponse.redirect(new URL('/account/change-password', req.nextUrl.origin))
  }

  // Mandatory MFA enrolment gate: privileged roles cannot do anything until
  // they have set up TOTP. CLAUDE.md §20. Exempt the setup page itself, the
  // change-password page (the only other thing they may need to do first),
  // sign-out, the auth API, and the healthcheck.
  if (
    session?.user &&
    !session.user.totpEnabledAt &&
    isPrivilegedRole(session.user.roles, session.user.role) &&
    !isPublicPath(pathname) &&
    pathname !== '/account/setup-2fa' &&
    pathname !== '/account/change-password' &&
    pathname !== '/api/auth/signout' &&
    !pathname.startsWith('/api/auth/') &&
    pathname !== '/api/health'
  ) {
    return NextResponse.redirect(new URL('/account/setup-2fa', req.nextUrl.origin))
  }

  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set('x-request-id', requestId)
  res.headers.set('Content-Security-Policy', csp)
  if (!shouldSkipAccessLog(pathname)) {
    logger.info(
      {
        request_id: requestId,
        method: req.method,
        path: pathname,
        status: res.status,
        latency_ms: Date.now() - start,
        actor_id: session?.user?.id ?? null,
        user_agent: req.headers.get('user-agent'),
      },
      'http_access',
    )
  }
  return res
}) as unknown as (req: NextRequest) => Promise<NextResponse>

const PRIVILEGED_ROLES = new Set(['super_admin', 'admin', 'finance', 'dsl'])

function isPrivilegedRole(
  roles: string[] | undefined,
  primary: string | undefined,
): boolean {
  if (Array.isArray(roles) && roles.some((r) => PRIVILEGED_ROLES.has(r))) return true
  if (primary && PRIVILEGED_ROLES.has(primary)) return true
  return false
}

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
}
