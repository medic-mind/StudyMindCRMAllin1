// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { accountRouter } from './routers/account'
import { adminRouter } from './routers/admin'
import { contactRouter } from './routers/contact'
import { costRouter } from './routers/cost'
import { dashboardRouter } from './routers/dashboard'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { notificationsRouter } from './routers/notifications'
import { oauthRouter } from './routers/oauth'
import { reportsRouter } from './routers/reports'
import { searchRouter } from './routers/search'
import { taskRouter } from './routers/task'

export const appRouter = router({
  account: accountRouter,
  admin: adminRouter,
  contact: contactRouter,
  cost: costRouter,
  dashboard: dashboardRouter,
  family: familyRouter,
  finance: financeRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  notifications: notificationsRouter,
  oauth: oauthRouter,
  reports: reportsRouter,
  search: searchRouter,
  task: taskRouter,
})

export type AppRouter = typeof appRouter
