// Compatibility helpers for server-side callers. ADR 0010.
//
// Older code paths (carried across from the Clerk era) expect the shape
// `{ userId, sessionClaims }`. NextAuth v5 gives us `Session | null`. We
// expose `getCurrentUser()` (the new shape) and `legacyAuth()` (the old
// shape) so route handlers and pages can migrate piecemeal.

import { auth as nextAuth } from './index'

import type { UserRole } from '@/lib/trpc/builders'

export interface CurrentUser {
  id: string
  email: string
  name?: string | null
  role: UserRole
  roles: UserRole[]
  mustResetPassword: boolean
  sessionId?: string
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await nextAuth()
  if (!session?.user?.id) return null
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name ?? null,
    role: session.user.role,
    roles: session.user.roles,
    mustResetPassword: session.user.mustResetPassword,
    sessionId: session.user.sessionId,
  }
}

/**
 * Clerk-shaped wrapper used by code paths that have not yet migrated to
 * `getCurrentUser`. The `sessionClaims` object mirrors the Clerk vocabulary:
 * `email`, `role`, `roles`, `mustResetPassword`. New code should prefer
 * `getCurrentUser()`.
 */
export async function legacyAuth(): Promise<{
  userId: string | null
  sessionClaims: {
    email?: string
    role?: UserRole
    roles?: UserRole[]
    mustResetPassword?: boolean
    sessionId?: string
  } | null
}> {
  const u = await getCurrentUser()
  if (!u) return { userId: null, sessionClaims: null }
  return {
    userId: u.id,
    sessionClaims: {
      email: u.email,
      role: u.role,
      roles: u.roles,
      mustResetPassword: u.mustResetPassword,
      sessionId: u.sessionId,
    },
  }
}
