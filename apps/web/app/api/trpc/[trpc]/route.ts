// tRPC fetch handler for the App Router.
//
// ADR 0010 chunk 5: NextAuth v5 wired in. Every request resolves the
// current session through `legacyAuth()`; procedures that require an
// authenticated caller throw `UNAUTHORIZED` when there is none.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch'

import { legacyAuth } from '@/lib/auth/server'
import { trpcContextFactory } from '@/lib/trpc/context'

import { appRouter } from '../root'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => trpcContextFactory(legacyAuth, req),
  })

export { handler as GET, handler as POST }
