// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { accountRouter } from './routers/account'
import { accountLabelRouter } from './routers/accountLabel'
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
import { callsRouter } from './routers/calls'
import { callSummaryTemplateRouter } from './routers/callSummaryTemplate'
import { customerRiskRouter } from './routers/customerRisk'
import { chatRouter } from './routers/chat'
import { companyRouter } from './routers/company'
import { complaintRouter } from './routers/complaint'
import { contactRouter } from './routers/contact'
import { contactBookingRouter } from './routers/contact-booking'
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
  booking: contactBookingRouter,
})
import { costRouter } from './routers/cost'
import { dashboardRouter } from './routers/dashboard'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { forwardingRouter } from './routers/forwarding'
import { contactSuggestionsRouter } from './routers/contact-suggestions'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { invoicingRouter } from './routers/invoicing'
import { leadRouter } from './routers/lead'
import { mailRouter } from './routers/mail'
import { mailAccountRouter } from './routers/mailAccount'
import { notificationsRouter } from './routers/notifications'
import { oauthRouter } from './routers/oauth'
import { pipelineRouter } from './routers/pipeline'
import { quickReplyRouter } from './routers/quickReply'
import { reportsRouter } from './routers/reports'
import { searchRouter } from './routers/search'
import { slackChannelRouter } from './routers/slackChannel'
import { slackSummaryRouter } from './routers/slackSummary'
import { summerCampRouter } from './routers/summerCamp'
import { taskRouter } from './routers/task'
import { teamRouter } from './routers/team'
import { uploadedInvoiceRouter } from './routers/uploadedInvoice'
import { webinarRouter } from './routers/webinar'

export const appRouter = router({
  account: accountRouter,
  accountLabel: accountLabelRouter,
  admin: adminRouter,
  board: boardRouter,
  boardQuickAction: boardQuickActionRouter,
  branding: brandingRouter,
  businessAccount: businessAccountRouter,
  calls: callsRouter,
  callSummaryTemplate: callSummaryTemplateRouter,
  customerRisk: customerRiskRouter,
  chat: chatRouter,
  company: companyRouter,
  card: cardRouter,
  complaint: complaintRouter,
  contact: contactWithChannels,
  label: labelRouter,
  subject: subjectRouter,
  cost: costRouter,
  dashboard: dashboardRouter,
  family: familyRouter,
  finance: financeRouter,
  forwarding: forwardingRouter,
  contactSuggestion: contactSuggestionsRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  invoicing: invoicingRouter,
  lead: leadRouter,
  mail: mailRouter,
  mailAccount: mailAccountRouter,
  notifications: notificationsRouter,
  oauth: oauthRouter,
  pipeline: pipelineRouter,
  quickReply: quickReplyRouter,
  reports: reportsRouter,
  search: searchRouter,
  slackChannel: slackChannelRouter,
  slackSummary: slackSummaryRouter,
  summerCamp: summerCampRouter,
  task: taskRouter,
  team: teamRouter,
  uploadedInvoice: uploadedInvoiceRouter,
  webinar: webinarRouter,
})

export type AppRouter = typeof appRouter
