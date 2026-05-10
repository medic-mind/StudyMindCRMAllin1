// Server-side tRPC helpers for RSC pages.
// RSCs read via this helper or via domain functions in @studymind/core.
//
// ADR 0010 chunk 3: Clerk has been excised. Until chunks 5-7 wire in
// Auth.js v5, the server caller runs with `user: null`. RSC callers
// that need an authenticated context must wait for the real auth wiring;
// procedures that require auth throw `UNAUTHORIZED`.

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'

import { appRouter } from '@/app/api/trpc/root'

import { createAuditRecorder, type TrpcContext } from './builders'

export async function createServerCaller() {
  const requestId = createId()
  const ctx: TrpcContext = {
    user: null,
    requestId,
    db,
    audit: createAuditRecorder(db, { actorId: null, requestId }),
    // RSC server callers are not subject to CSRF; mutations through this
    // path are RSC-internal and never triggered by an external Origin.
    headers: { origin: null, host: null },
  }
  return appRouter.createCaller(ctx)
}
