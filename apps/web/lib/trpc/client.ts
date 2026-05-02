// Client-side tRPC react helpers.

import { createTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '@/app/api/trpc/root'

export const trpc = createTRPCReact<AppRouter>()
