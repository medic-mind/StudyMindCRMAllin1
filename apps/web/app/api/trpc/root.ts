// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { contactRouter } from './routers/contact'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { safeguardingRouter } from './routers/safeguarding'

export const appRouter = router({
  contact: contactRouter,
  family: familyRouter,
  finance: financeRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  safeguarding: safeguardingRouter,
})

export type AppRouter = typeof appRouter
