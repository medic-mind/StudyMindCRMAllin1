// Shared context factory used by both the HTTP fetch handler and the RSC caller.

import { createId } from '@paralleldrive/cuid2'

import { currentTraceId } from '@studymind/core/observability/trace'
import { db } from '@studymind/db'

import { createAuditRecorder, type SessionUser, type TrpcContext } from './builders'

type AuthFn = () => Promise<{
  userId: string | null | undefined
  sessionClaims?: Record<string, unknown> | null
}>

export async function trpcContextFactory(authFn: AuthFn): Promise<TrpcContext> {
  const { userId, sessionClaims } = await authFn()
  const email = (sessionClaims?.['email'] as string | undefined) ?? ''
  const role = (sessionClaims?.['role'] as SessionUser['role'] | undefined) ?? 'agent'
  // Prefer the active OTel trace id so the request can be correlated across
  // logs, audit entries, and traces. Fall back to cuid2 when tracing is off.
  const requestId = currentTraceId() ?? createId()
  return {
    user: userId ? { id: userId, email, role } : null,
    requestId,
    db,
    audit: createAuditRecorder(db, { actorId: userId ?? null, requestId }),
  }
}
