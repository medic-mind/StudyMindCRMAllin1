// tRPC fetch handler for the App Router.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { auth } from '@clerk/nextjs/server'
import { appRouter } from '../root'
import type { TrpcContext } from '@/lib/trpc/builders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function createContext(): Promise<TrpcContext> {
  const { userId, sessionClaims } = await auth()
  const email = (sessionClaims?.['email'] as string | undefined) ?? ''
  return {
    user: userId ? { id: userId, email } : null,
    requestId: crypto.randomUUID(),
    audit: async () => {
      // Skeleton — wire to @studymind/audit writer.
    },
  }
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext,
  })

export { handler as GET, handler as POST }
