// tRPC fetch handler for the App Router.

import { fetchRequestHandler } from '@trpc/server/adapters/fetch'
import { auth } from '@clerk/nextjs/server'

import { trpcContextFactory } from '@/lib/trpc/context'

import { appRouter } from '../root'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    createContext: () => trpcContextFactory(auth, req),
  })

export { handler as GET, handler as POST }
