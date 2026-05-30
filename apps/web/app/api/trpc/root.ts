// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { accountRouter } from './routers/account'
import { adminRouter } from './routers/admin'
import {
  boardQuickActionRouter,
  boardRouter,
  cardRouter,
  labelRouter,
  subjectRouter,
} from './routers/board'
import { brandingRouter } from './routers/branding'
import { businessAccountRouter } from './routers/businessAccount'
import { callSummaryTemplateRouter } from './routers/callSummaryTemplate'
import { chatRouter } from './routers/chat'
import { companyRouter } from './routers/company'
import { contactRouter } from './routers/contact'
import { contactChannelsRouter } from './routers/contact-channels'

// `contact.channels.*` namespace lives in its own file (ADR 0017) to keep
// the contact router focused on CRUD. We merge it under `contact` at the
// root so callers use `trpc.contact.channels.emailThreads`.
const contactWithChannels = router({
  list: contactRouter.list,
  get: contactRouter.get,
  create: contactRouter.create,
  update: contactRouter.update,
  mergeSuggestions: contactRouter.mergeSuggestions,
  merge: contactRouter.merge,
  bulkMerge: contactRouter.bulkMerge,
  bulkSoftDelete: contactRouter.bulkSoftDelete,
  bulkMailchimpPush: contactRouter.bulkMailchimpPush,
  links: contactRouter.links,
  documents: contactRouter.documents,
  callSummary: contactRouter.callSummary,
  mailchimp: contactRouter.mailchimp,
  channels: contactChannelsRouter,
})
import { costRouter } from './routers/cost'
import { dashboardRouter } from './routers/dashboard'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { forwardingRouter } from './routers/forwarding'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { invoicingRouter } from './routers/invoicing'
import { notificationsRouter } from './routers/notifications'
import { oauthRouter } from './routers/oauth'
import { pipelineRouter } from './routers/pipeline'
import { reportsRouter } from './routers/reports'
import { searchRouter } from './routers/search'
import { taskRouter } from './routers/task'
import { teamRouter } from './routers/team'
import { uploadedInvoiceRouter } from './routers/uploadedInvoice'

export const appRouter = router({
  account: accountRouter,
  admin: adminRouter,
  board: boardRouter,
  boardQuickAction: boardQuickActionRouter,
  branding: brandingRouter,
  businessAccount: businessAccountRouter,
  callSummaryTemplate: callSummaryTemplateRouter,
  chat: chatRouter,
  company: companyRouter,
  card: cardRouter,
  contact: contactWithChannels,
  label: labelRouter,
  subject: subjectRouter,
  cost: costRouter,
  dashboard: dashboardRouter,
  family: familyRouter,
  finance: financeRouter,
  forwarding: forwardingRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  invoicing: invoicingRouter,
  notifications: notificationsRouter,
  oauth: oauthRouter,
  pipeline: pipelineRouter,
  reports: reportsRouter,
  search: searchRouter,
  task: taskRouter,
  team: teamRouter,
  uploadedInvoice: uploadedInvoiceRouter,
})

export type AppRouter = typeof appRouter
