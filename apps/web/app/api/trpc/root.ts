// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'
import { contactRouter } from './routers/contact'

export const appRouter = router({
  contact: contactRouter,
})

export type AppRouter = typeof appRouter
