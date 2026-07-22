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
import { mfaEnrolmentRequired, resolveMfaEnforcementMode } from '@/lib/auth/mfa-policy'
import { buildCsp, generateNonce } from '@/lib/security/csp'

const { auth: authMiddleware } = NextAuth(authEdgeConfig)

const PUBLIC_PATH_PREFIXES = [
  '/sign-in',
  // '/sign-up' intentionally omitted — public self-service sign-up is disabled
  // (ADR 0021). Accounts are created only by a CEO or Senior Manager.
  '/verify',
  '/verify-email-sent',
  '/forgot',
  '/reset',
  '/auth/error',
  '/api/auth',
  '/api/webhooks',
  // Inngest serve/sync endpoint. Inngest authenticates its requests with the
  // INNGEST_SIGNING_KEY signature the serve handler verifies — not a session
  // — exactly like the webhooks above. It MUST bypass the auth gate, or
  // Inngest's sync + function invocations get 307-redirected to /sign-in and
  // the dashboard reports "We could not reach your URL".
  '/api/inngest',
  // Universal lead ingestion (ADR 0020) — authenticated by a per-source API
  // key, not a session, so WordPress / Contact-Form-7 sites can POST to it.
  '/api/leads',
  '/api/oauth/gmail/callback',
  '/api/health',
  // Custom brand logo bytes — rendered on the unauthenticated sign-in screen.
  '/api/branding/logo',
  // GoCardless hosted mandate flow (ADR 0038): the parent's browser opens the
  // durable setup link and returns to the completion route after confirming
  // bank details. Authenticated by an unguessable token / redirect_flow_id,
  // not a session.
  '/api/gocardless/setup',
  '/api/gocardless/redirect-flow/complete',
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
  // Expose the path to server components (the (app) layout reads it so its
  // mustResetPassword guard never redirects the change-password page to itself
  // → ERR_TOO_MANY_REDIRECTS). Set on the request headers that flow through to
  // the RSC render below.
  requestHeaders.set('x-pathname', pathname)

  // The email reading-pane render route (ADR 0041) returns sanitised email HTML
  // to be framed by /mail. It MUST carry its own relaxed CSP (remote images +
  // inline styles, no scripts) and be same-origin framable, so we let it through
  // WITHOUT the app's strict CSP / X-Frame-Options DENY (next.config also
  // excludes it). It self-authenticates in the handler, so skipping the auth
  // redirect here is safe.
  if (pathname.startsWith('/api/internal/mail-render/')) {
    return NextResponse.next()
  }

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
    // NEVER redirect an /api request to the sign-in HTML page — the caller
    // expects JSON and a 307→HTML surfaces as "Unexpected token '<' … not valid
    // JSON". Return a clean 401 instead; the tRPC/route handler's own auth still
    // applies. Only page navigations bounce to /sign-in.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    const signInUrl = new URL('/sign-in', req.nextUrl.origin)
    signInUrl.searchParams.set('callbackUrl', req.nextUrl.pathname + req.nextUrl.search)
    return NextResponse.redirect(signInUrl)
  }

  // Force-reset gate: a user holding mustResetPassword can only reach the
  // change-password page. It must NOT redirect /api requests to HTML — the
  // change-password form itself calls tRPC (`/api/trpc/account.changePassword`),
  // and redirecting that to the HTML page is what produced "Unexpected token
  // '<' … not valid JSON" on Save. Exempt ALL /api (mirroring the MFA gate);
  // the mutations enforce their own auth server-side. ADR 0010, chunk 7.
  if (
    session?.user?.mustResetPassword &&
    !isPublicPath(pathname) &&
    pathname !== '/account/change-password' &&
    !pathname.startsWith('/api/')
  ) {
    return NextResponse.redirect(new URL('/account/change-password', req.nextUrl.origin))
  }

  // Mandatory MFA enrolment gate (CLAUDE.md §20, policy in lib/auth/mfa-policy):
  // ON for every staff role by DEFAULT — on first sign-in the user is sent to
  // /account/setup-2fa and cannot use the CRM until they enrol (not completing
  // it never locks the account; they are simply re-prompted next sign-in). Set
  // MANDATORY_MFA_ENABLED='true' to narrow the gate to privileged roles, or
  // 'false' to pause it. The policy exempts the setup + change-password pages
  // and ALL /api/ paths — redirecting a JSON request to an HTML page is what
  // produced the "Unexpected token '<' … not valid JSON" sign-in error.
  if (
    session?.user &&
    !isPublicPath(pathname) &&
    mfaEnrolmentRequired({
      mode: resolveMfaEnforcementMode(process.env['MANDATORY_MFA_ENABLED']),
      roles: session.user.roles,
      role: session.user.role,
      totpEnabled: Boolean(session.user.totpEnabledAt),
      pathname,
    })
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

function cryptoRandomId(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const config = {
  matcher: ['/((?!_next|.*\\..*).*)', '/(api|trpc)(.*)'],
}
