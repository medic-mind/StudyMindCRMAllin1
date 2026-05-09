// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { contactRouter } from './routers/contact'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { lacontractRouter } from './routers/lacontract'
import { safeguardingRouter } from './routers/safeguarding'
import { tenderRouter } from './routers/tender'

export const appRouter = router({
  contact: contactRouter,
  family: familyRouter,
  finance: financeRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  lacontract: lacontractRouter,
  safeguarding: safeguardingRouter,
  tender: tenderRouter,
})

export type AppRouter = typeof appRouter
