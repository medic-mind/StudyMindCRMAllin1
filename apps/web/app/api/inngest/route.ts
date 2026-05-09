// Inngest serve handler. CLAUDE.md §17: every async unit of work is an
// Inngest function; this route is where the platform invokes them.
//
// Cross-cutting functions live in `packages/jobs`. Integration-specific
// functions live in `packages/integrations/<svc>/jobs.ts` and are pulled in
// here so a single endpoint registers everything Inngest can dispatch.
//
// Auth: this endpoint is public to Clerk (see middleware) and authenticated
// by the INNGEST_SIGNING_KEY signature header that the framework verifies.

import { serve } from 'inngest/next'

import { FUNCTIONS as AIRCALL_FUNCTIONS } from '@studymind/integration-aircall/jobs'
import { FUNCTIONS as ASANA_FUNCTIONS } from '@studymind/integration-asana/jobs'
import { FUNCTIONS as BOOKING_FUNCTIONS } from '@studymind/integration-booking/jobs'
import { FUNCTIONS as GMAIL_FUNCTIONS } from '@studymind/integration-gmail/jobs'
import { FUNCTIONS as GOCARDLESS_FUNCTIONS } from '@studymind/integration-gocardless/jobs'
import { FUNCTIONS as SLACK_FUNCTIONS } from '@studymind/integration-slack/jobs'
import { FUNCTIONS as STRIPE_FUNCTIONS } from '@studymind/integration-stripe/jobs'
import { FUNCTIONS as TRENGO_FUNCTIONS } from '@studymind/integration-trengo/jobs'
import { CROSS_CUTTING_FUNCTIONS, inngest } from '@studymind/jobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    ...CROSS_CUTTING_FUNCTIONS,
    ...STRIPE_FUNCTIONS,
    ...GOCARDLESS_FUNCTIONS,
    ...BOOKING_FUNCTIONS,
    ...AIRCALL_FUNCTIONS,
    ...TRENGO_FUNCTIONS,
    ...SLACK_FUNCTIONS,
    ...ASANA_FUNCTIONS,
    ...GMAIL_FUNCTIONS,
  ],
  signingKey: process.env['INNGEST_SIGNING_KEY'],
})
