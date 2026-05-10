// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { adminRouter } from './routers/admin'
import { contactRouter } from './routers/contact'
import { costRouter } from './routers/cost'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { reportsRouter } from './routers/reports'
import { safeguardingRouter } from './routers/safeguarding'

export const appRouter = router({
  admin: adminRouter,
  contact: contactRouter,
  cost: costRouter,
  family: familyRouter,
  finance: financeRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  reports: reportsRouter,
  safeguarding: safeguardingRouter,
})

export type AppRouter = typeof appRouter
