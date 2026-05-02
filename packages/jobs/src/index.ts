// @studymind/jobs — cross-cutting Inngest functions.
// Integration-specific jobs live in packages/integrations/<svc>/jobs.ts.
// See CLAUDE.md Section 17.

import { Inngest } from 'inngest'

export const inngest = new Inngest({
  id: 'studymind-crm',
  eventKey: process.env['INNGEST_EVENT_KEY'],
})

export interface RecurringJobSpec {
  id: string
  cron: string
  description: string
}

// Recurring jobs from CLAUDE.md Section 17.1.
export const RECURRING_JOBS: readonly RecurringJobSpec[] = [
  {
    id: 'finance/reconcile-all-families',
    cron: '0 2 * * *',
    description: 'Walk every active Family, raise discrepancies',
  },
  {
    id: 'ai/score-churn-risk',
    cron: '0 3 * * *',
    description: 'Score every Family, create retention tasks above threshold',
  },
  {
    id: 'compliance/enforce-retention',
    cron: '0 4 * * *',
    description: 'Soft delete or hard delete data per RetentionPolicy',
  },
  {
    id: 'compliance/audit-log-archive',
    cron: '0 5 * * 0',
    description: 'Archive AuditLogEntry older than 12 months to cold storage',
  },
  {
    id: 'gmail/refresh-watch',
    cron: '0 6 * * *',
    description: 'Renew Gmail Pub/Sub watches that expire within 24h',
  },
  {
    id: 'booking/sync-active-families',
    cron: '*/5 * * * *',
    description: 'Pull booking changes for active Families',
  },
  {
    id: 'booking/sync-inactive-families',
    cron: '0 * * * *',
    description: 'Pull booking changes for inactive Families',
  },
  {
    id: 'ai/regenerate-status-summaries',
    cron: '*/30 * * * *',
    description: 'Refresh the 2 sentence Current Status header for changed contacts',
  },
  {
    id: 'aircall/recover-disabled-webhook',
    cron: '0 * * * *',
    description: 'Re-enable Aircall webhook if it was disabled by failures',
  },
  {
    id: 'gocardless/reconcile-late-failures',
    cron: '0 */4 * * *',
    description: 'Walk recent confirmations and surface any new late failures',
  },
]

// Function definitions land here as they are implemented.
export const functions: ReturnType<typeof inngest.createFunction>[] = []
