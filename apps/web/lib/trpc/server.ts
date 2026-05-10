// Server-side tRPC helpers for RSC pages.
// RSCs read via this helper or via domain functions in @studymind/core.
//
// ADR 0010 chunk 5: real auth via NextAuth v5. RSC callers run with the
// current session; procedures that require auth throw UNAUTHORIZED when
// there is no session.

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'

import { getCurrentUser } from '@/lib/auth/server'

import { appRouter } from '@/app/api/trpc/root'

import { createAuditRecorder, type SessionUser, type TrpcContext } from './builders'

export async function createServerCaller() {
  const requestId = createId()
  const me = await getCurrentUser()
  const user: SessionUser | null = me
    ? { id: me.id, email: me.email, role: me.role }
    : null
  const ctx: TrpcContext = {
    user,
    requestId,
    db,
    audit: createAuditRecorder(db, { actorId: user?.id ?? null, requestId }),
    // RSC server callers are not subject to CSRF; mutations through this
    // path are RSC-internal and never triggered by an external Origin.
    headers: { origin: null, host: null },
  }
  return appRouter.createCaller(ctx)
}
