'use client'

// tRPC + React Query provider for client components.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpBatchLink } from '@trpc/client'
import { useState, type ReactNode } from 'react'
import superjson from 'superjson'

import { trpc } from './client'

/**
 * Defensive fetch for the tRPC link. If any layer returns a NON-JSON body — a
 * Railway/proxy gateway page during a worker restart (502/503/504), a framework
 * 500 HTML page, or an auth redirect that resolved to a page — tRPC would try to
 * JSON-parse HTML and surface the raw "Unexpected token '<', <!DOCTYPE … not
 * valid JSON" to the user. Detect that here and throw ONE clean, actionable
 * message instead, so that whole error class never reaches a toast. Proper tRPC
 * responses (application/json) pass straight through untouched.
 */
async function trpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(
      res.status >= 500
        ? `The server had a problem (${res.status}). Please try again in a moment.`
        : res.status === 401 || res.status === 403
          ? 'Your session may have expired — please refresh the page or sign in again.'
          : `Something went wrong (${res.status || 'network'}). Please try again.`,
    )
  }
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
