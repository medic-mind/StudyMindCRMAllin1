// Inngest client singleton. Extracted into its own module so cross-cutting
// jobs (reconcile, retention, etc.) can import the client without creating
// a cycle through the package's `index.ts` aggregator.

import { Inngest } from 'inngest'

export const inngest = new Inngest({
  id: 'studymind-crm',
  eventKey: process.env['INNGEST_EVENT_KEY'],
})
