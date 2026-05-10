// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { accountRouter } from './routers/account'
import { adminRouter } from './routers/admin'
import { contactRouter } from './routers/contact'
import { costRouter } from './routers/cost'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { oauthRouter } from './routers/oauth'
import { reportsRouter } from './routers/reports'
import { safeguardingRouter } from './routers/safeguarding'

export const appRouter = router({
  account: accountRouter,
  admin: adminRouter,
  contact: contactRouter,
  cost: costRouter,
  family: familyRouter,
  finance: financeRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  oauth: oauthRouter,
  reports: reportsRouter,
  safeguarding: safeguardingRouter,
})

export type AppRouter = typeof appRouter
