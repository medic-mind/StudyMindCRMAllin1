// tRPC fetch handler for the App Router.
//
// ADR 0010 chunk 3: Clerk has been excised. Until chunks 5-7 wire in
// Auth.js v5, every request comes through with `user: null`. Procedures
// that require an authenticated caller throw `UNAUTHORIZED`.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { trpcContextFactory } from '@/lib/trpc/context'

import { appRouter } from '../root'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function nullAuth() {
  return { userId: null, sessionClaims: null }
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => trpcContextFactory(nullAuth, req),
  })

export { handler as GET, handler as POST }
