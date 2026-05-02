// Server-side tRPC helpers for RSC pages.
// RSCs read via this helper or via domain functions in @studymind/core.

import { auth } from '@clerk/nextjs/server'

import { db } from '@studymind/db'

import { appRouter } from '@/app/api/trpc/root'

import { createAuditRecorder, type TrpcContext, type SessionUser } from './builders'

export async function createServerCaller() {
  const { userId, sessionClaims } = await auth()
  const email = (sessionClaims?.['email'] as string | undefined) ?? ''
  const role = (sessionClaims?.['role'] as SessionUser['role'] | undefined) ?? 'agent'
  const requestId = crypto.randomUUID()
  const ctx: TrpcContext = {
    user: userId ? { id: userId, email, role } : null,
    requestId,
    db,
    audit: createAuditRecorder(db, { actorId: userId ?? null, requestId }),
  }
  return appRouter.createCaller(ctx)
}
