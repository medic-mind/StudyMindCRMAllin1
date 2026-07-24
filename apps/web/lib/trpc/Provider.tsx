'use client'

// tRPC + React Query provider for client components.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { useState, type ReactNode } from 'react'
import superjson from 'superjson'

import { trpc } from './client'
import { trpcResponseError } from './response-error'

/**
 * Defensive fetch for the tRPC link. Turns two opaque failure classes into ONE
 * clean, actionable message so they never reach the user as a cryptic toast:
 * a NON-JSON body (gateway/500 HTML page → "Unexpected token '<' … not valid
 * JSON") and a 401 whose body isn't a tRPC envelope (the middleware's
 * `{ error: 'unauthorized' }` on an expired session → "Unable to transform
 * response from server"). Proper tRPC responses pass straight through. Decision
 * logic + rationale live in the unit-tested `trpcResponseError`.
 */
async function trpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  const message = trpcResponseError(res.status, res.headers.get('content-type') ?? '')
  if (message) throw new Error(message)
  return res
}

export function TrpcProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: '/api/trpc',
          transformer: superjson,
          fetch: trpcFetch,
        }),
      ],
    }),
  )
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  )
}
