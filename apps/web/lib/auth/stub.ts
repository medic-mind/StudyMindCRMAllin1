// Temporary auth stub for the Clerk → Auth.js v5 pivot.
//
// ADR 0010 chunk 3 removes Clerk wholesale. The real implementation
// (NextAuth Credentials provider + Prisma adapter) lands in chunks 5-7;
// until then this stub keeps the type surface stable. Any caller that
// hits it at runtime gets a `BusinessError('AUTH_PIVOT_PENDING')` so we
// can never accidentally serve an unauthenticated session to a procedure
// that requires one.
//
// CLAUDE.md §20 (Auth, RBAC, audit), ADR 0010.

import { BusinessError } from '@studymind/core/errors'

export interface StubSession {
  userId: string | null
  sessionClaims: Record<string, unknown> | null
}

/**
 * Stand-in for Clerk's `auth()` and Auth.js's `auth()` server helper. Throws
 * at call time — the build does not exercise this path because every caller
 * is gated behind `dynamic = 'force-dynamic'` or runs inside a request
 * handler that the build never invokes.
 */
export async function auth(): Promise<StubSession> {
  throw new BusinessError(
    'AUTH_PIVOT_PENDING',
    'Authentication is being rebuilt on Auth.js v5; sign-in returns in chunks 5-7 of ADR 0010.',
  )
}
