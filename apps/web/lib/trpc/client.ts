// Client-side tRPC react helpers.

import { createTRPCReact } from '@trpc/react-query'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/app/api/trpc/root'

export const trpc = createTRPCReact<AppRouter>()

/** Inferred output types for every procedure, e.g.
 *  `RouterOutputs['invoicing']['invoices']['list'][number]`. */
export type RouterOutputs = inferRouterOutputs<AppRouter>
