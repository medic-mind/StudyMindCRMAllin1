// Inngest serve handler. CLAUDE.md §17: every async unit of work is an
// Inngest function; this route is where the platform invokes them.
//
// Cross-cutting functions live in `packages/jobs`. Integration-specific
// functions live in `packages/integrations/<svc>/jobs.ts` and are pulled in
// here so a single endpoint registers everything Inngest can dispatch.
//
// Auth: this endpoint is public to the NextAuth middleware (ADR 0010) and
// authenticated by the INNGEST_SIGNING_KEY signature header that the
// framework verifies.

import { serve } from 'inngest/next'

import { withSentry } from '@studymind/core/observability/sentry'
import { FUNCTIONS as AIRCALL_FUNCTIONS } from '@studymind/integration-aircall/jobs'
import { FUNCTIONS as BOOKING_FUNCTIONS } from '@studymind/integration-booking/jobs'
import { FUNCTIONS as GMAIL_FUNCTIONS } from '@studymind/integration-gmail/jobs'
import { FUNCTIONS as GOCARDLESS_FUNCTIONS } from '@studymind/integration-gocardless/jobs'
import { FUNCTIONS as INVOICING_FUNCTIONS } from '@studymind/integration-invoicing/jobs'
import { FUNCTIONS as SLACK_FUNCTIONS } from '@studymind/integration-slack/jobs'
import { FUNCTIONS as STRIPE_FUNCTIONS } from '@studymind/integration-stripe/jobs'
import { FUNCTIONS as SUMMER_CAMP_FUNCTIONS } from '@studymind/integration-summer-camp/jobs'
import { FUNCTIONS as TRENGO_FUNCTIONS } from '@studymind/integration-trengo/jobs'
import { CROSS_CUTTING_FUNCTIONS, inngest } from '@studymind/jobs'

import { autoMergeDuplicatesHourly } from './_boundary/auto-merge-duplicates'
import { costSummaryWeekly } from './_boundary/cost-summary'
import { auditLogArchiveWeekly } from './_boundary/audit-log-archive'
import { eraseDueRecordsDaily } from './_boundary/erase-due-records'
import { flagDdDefaultersNightly } from './_boundary/flag-dd-defaulters'
import { gocardlessSetupLinkMaintenance } from './_boundary/gocardless-setup-links'
import { ddChaseTick } from './_boundary/dd-chase'
import {
  leadBackfillCountries,
  leadClassifyRequested,
  leadReprocessUnresolved,
} from './_boundary/process-lead'
import { purchaseEmailReceived } from './_boundary/purchase-email'
import { uebaWeekly } from './_boundary/ueba'
import { userLoginReminders } from './_boundary/user-login-reminders'
import { WEBINAR_BOUNDARY_FUNCTIONS } from './_boundary/webinar'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Worker-boundary functions: registrations that pair pure jobs with
// integration-side glue (S3, Slack outbound) without creating a
// jobs ↔ integrations import cycle (CLAUDE.md §17).
const BOUNDARY_FUNCTIONS = [
  autoMergeDuplicatesHourly,
  costSummaryWeekly,
  auditLogArchiveWeekly,
  eraseDueRecordsDaily,
  ddChaseTick,
  flagDdDefaultersNightly,
  gocardlessSetupLinkMaintenance,
  leadBackfillCountries,
  leadClassifyRequested,
  leadReprocessUnresolved,
  purchaseEmailReceived,
  uebaWeekly,
  userLoginReminders,
  ...WEBINAR_BOUNDARY_FUNCTIONS,
]

const handlers = serve({
  client: inngest,
  functions: [
    ...CROSS_CUTTING_FUNCTIONS,
    ...BOUNDARY_FUNCTIONS,
    ...STRIPE_FUNCTIONS,
    ...GOCARDLESS_FUNCTIONS,
    ...BOOKING_FUNCTIONS,
    ...AIRCALL_FUNCTIONS,
    ...TRENGO_FUNCTIONS,
    ...SLACK_FUNCTIONS,
    ...GMAIL_FUNCTIONS,
    ...INVOICING_FUNCTIONS,
    ...SUMMER_CAMP_FUNCTIONS,
  ],
  signingKey: process.env['INNGEST_SIGNING_KEY'],
})

const tags = { surface: 'inngest_serve' }
export const GET = withSentry(handlers.GET, tags)
export const POST = withSentry(handlers.POST, tags)
export const PUT = withSentry(handlers.PUT, tags)
