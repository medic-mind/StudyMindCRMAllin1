// Server-side tRPC helpers for RSC pages.
// RSCs read via this helper or via domain functions in @studymind/core.

import { auth } from '@clerk/nextjs/server'
import { appRouter } from '@/app/api/trpc/root'
import type { TrpcContext } from './builders'

export async function createServerCaller() {
  const { userId, sessionClaims } = await auth()
  const email = (sessionClaims?.['email'] as string | undefined) ?? ''
  const ctx: TrpcContext = {
    user: userId ? { id: userId, email } : null,
    requestId: crypto.randomUUID(),
    audit: async () => {
      // Skeleton — wire to @studymind/audit writer.
    },
  }
  return appRouter.createCaller(ctx)
}
