// Root tRPC router. Register new domain routers here.

import { router } from '@/lib/trpc/builders'

import { accountRouter } from './routers/account'
import { accountLabelRouter } from './routers/accountLabel'
import { adminRouter } from './routers/admin'
import { auditRouter } from './routers/audit'
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
import { callSummariesRouter } from './routers/callSummary'
import { customerRiskRouter } from './routers/customerRisk'
import { chatRouter } from './routers/chat'
import { companyRouter } from './routers/company'
import { complaintRouter } from './routers/complaint'
import { contactRouter } from './routers/contact'
import { contactDuplicatesRouter } from './routers/contact-duplicates'
import { contactBookingRouter } from './routers/contact-booking'
import { contactChannelsRouter } from './routers/contact-channels'
import { contactPointsRouter } from './routers/contact-points'

// `contact.channels.*` namespace lives in its own file (ADR 0017) to keep
// the contact router focused on CRUD. We merge it under `contact` at the
// root so callers use `trpc.contact.channels.emailThreads`.
const contactWithChannels = router({
  list: contactRouter.list,
  exportRows: contactRouter.exportRows,
  filterFacets: contactRouter.filterFacets,
  get: contactRouter.get,
  create: contactRouter.create,
  update: contactRouter.update,
  mergeSuggestions: contactRouter.mergeSuggestions,
  merge: contactRouter.merge,
  bulkMerge: contactRouter.bulkMerge,
  bulkSoftDelete: contactRouter.bulkSoftDelete,
  erase: contactRouter.erase,
  scheduleErasure: contactRouter.scheduleErasure,
  cancelErasure: contactRouter.cancelErasure,
  bulkMailchimpPush: contactRouter.bulkMailchimpPush,
  links: contactRouter.links,
  documents: contactRouter.documents,
  callSummary: contactRouter.callSummary,
  mailchimp: contactRouter.mailchimp,
  channels: contactChannelsRouter,
  points: contactPointsRouter,
  booking: contactBookingRouter,
  duplicates: contactDuplicatesRouter,
})
import { costRouter } from './routers/cost'
import { dashboardRouter } from './routers/dashboard'
import { familyRouter } from './routers/family'
import { financeRouter } from './routers/finance'
import { forwardingRouter } from './routers/forwarding'
import { gocardlessRouter } from './routers/gocardless'
import { contactSuggestionsRouter } from './routers/contact-suggestions'
import { inboxRouter } from './routers/inbox'
import { interactionRouter } from './routers/interaction'
import { invoicingRouter } from './routers/invoicing'
import { knowledgeRouter } from './routers/knowledge'
import { leadRouter } from './routers/lead'
import { mailRouter } from './routers/mail'
import { mailAccountRouter } from './routers/mailAccount'
import { notificationsRouter } from './routers/notifications'
import { oauthRouter } from './routers/oauth'
import { ddRecoveryTemplateRouter } from './routers/ddRecoveryTemplate'
import { ddRecoverySettingsRouter } from './routers/ddRecoverySettings'
import { pipelineRouter } from './routers/pipeline'
import { quickReplyRouter } from './routers/quickReply'
import { reportsRouter } from './routers/reports'
import { searchRouter } from './routers/search'
import { slackChannelRouter } from './routers/slackChannel'
import { slackSummaryRouter } from './routers/slackSummary'
import { summerCampRouter } from './routers/summerCamp'
import { roleRouter } from './routers/role'
import { teamRouter } from './routers/team'
import { uploadedInvoiceRouter } from './routers/uploadedInvoice'
import { webinarRouter } from './routers/webinar'

export const appRouter = router({
  account: accountRouter,
  accountLabel: accountLabelRouter,
  admin: adminRouter,
  audit: auditRouter,
  board: boardRouter,
  boardQuickAction: boardQuickActionRouter,
  branding: brandingRouter,
  businessAccount: businessAccountRouter,
  calls: callsRouter,
  callSummaries: callSummariesRouter,
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
  gocardless: gocardlessRouter,
  contactSuggestion: contactSuggestionsRouter,
  inbox: inboxRouter,
  interaction: interactionRouter,
  invoicing: invoicingRouter,
  knowledge: knowledgeRouter,
  lead: leadRouter,
  mail: mailRouter,
  mailAccount: mailAccountRouter,
  notifications: notificationsRouter,
  oauth: oauthRouter,
  pipeline: pipelineRouter,
  quickReply: quickReplyRouter,
  ddRecoveryTemplate: ddRecoveryTemplateRouter,
  ddRecoverySettings: ddRecoverySettingsRouter,
  reports: reportsRouter,
  search: searchRouter,
  slackChannel: slackChannelRouter,
  slackSummary: slackSummaryRouter,
  summerCamp: summerCampRouter,
  team: teamRouter,
  role: roleRouter,
  uploadedInvoice: uploadedInvoiceRouter,
  webinar: webinarRouter,
})

export type AppRouter = typeof appRouter
