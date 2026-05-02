// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { contactRouter } from './routers/contact'
import { familyRouter } from './routers/family'
import { interactionRouter } from './routers/interaction'

export const appRouter = router({
  contact: contactRouter,
  family: familyRouter,
  interaction: interactionRouter,
})

export type AppRouter = typeof appRouter
