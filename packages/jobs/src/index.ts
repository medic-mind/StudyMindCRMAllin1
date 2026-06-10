// @studymind/jobs — cross-cutting Inngest functions.
// Integration-specific jobs live in packages/integrations/<svc>/jobs.ts.
// See CLAUDE.md Section 17.

import { inngest } from './client'
import { RECONCILE_FUNCTIONS } from './reconcile'
import { CHURN_SCORE_FUNCTIONS } from './ai/churn-score'
import { STATUS_SUMMARY_FUNCTIONS } from './ai/status-summary'
import { COST_SUMMARY_FUNCTIONS } from './cost-summary'
import { AUDIT_LOG_ARCHIVE_FUNCTIONS } from './compliance/audit-log-archive'
import { UEBA_FUNCTIONS } from './security/ueba'
import { OBSERVABILITY_FUNCTIONS } from './observability'
import { BACKFILL_REAPER_FUNCTIONS } from './backfill/reap-stale'
import { MEDI_FUNCTIONS } from './medi/process-account'

export { inngest } from './client'

// Cross-cutting Inngest functions (reconciliation, retention, churn) land
// here as they are implemented. Integration-specific functions are imported
// in `apps/web/app/api/inngest/route.ts` from each integration package.
export const CROSS_CUTTING_FUNCTIONS: ReturnType<typeof inngest.createFunction>[] = [
  ...RECONCILE_FUNCTIONS,
  ...STATUS_SUMMARY_FUNCTIONS,
  ...CHURN_SCORE_FUNCTIONS,
  ...COST_SUMMARY_FUNCTIONS,
  ...AUDIT_LOG_ARCHIVE_FUNCTIONS,
  ...UEBA_FUNCTIONS,
  ...OBSERVABILITY_FUNCTIONS,
  ...BACKFILL_REAPER_FUNCTIONS,
  ...MEDI_FUNCTIONS,
]

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
    id: 'booking/sync-students',
    cron: '*/5 * * * *',
    description: 'Pull changed students from booking.studymind.co.uk (ADR 0029)',
  },
  {
    id: 'booking/sync-lessons',
    cron: '*/5 * * * *',
    description: 'Pull changed lessons from booking.studymind.co.uk',
  },
  {
    id: 'booking/sync-balance-ledger',
    cron: '*/15 * * * *',
    description: 'Pull the booking hours-balance ledger',
  },
  {
    id: 'booking/sync-credit-ledger',
    cron: '*/15 * * * *',
    description: 'Pull the booking credit ledger',
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
    id: 'backfill/reap-stale',
    cron: '*/10 * * * *',
    description:
      'Fail backfill jobs stuck pending/running with no progress past the stale window, so an abandoned import self-heals instead of showing a permanent "Importing 0 items…" banner (ADR 0017)',
  },
  {
    id: 'gocardless/reconcile-late-failures',
    cron: '0 */4 * * *',
    description: 'Walk recent confirmations and surface any new late failures',
  },
  {
    id: 'cost/weekly-summary',
    cron: '0 9 * * 1',
    description:
      'Aggregate AI + storage costs from the last 7 days, persist a markdown report, post to #crm-finops',
  },
  // Slice 14 (CLAUDE.md §25.1, §17).
  {
    id: 'observability/slo-monitor',
    cron: '*/5 * * * *',
    description: 'Detect SLO violations from Axiom and page on-call when out of budget',
  },
  {
    id: 'observability/cron-watchdog',
    cron: '*/15 * * * *',
    description: 'Detect missed recurring jobs via CronRun heartbeat and page on-call',
  },
  // Weekly-webinar auto-enrollment system (boundary functions registered in
  // apps/web/app/api/inngest/_boundary/webinar.ts).
  {
    id: 'webinar/dispatch-weekly-emails',
    cron: '0 * * * *',
    description: 'Send the weekly class email (Zoom link + PDF schedule) for any session now due',
  },
  {
    id: 'webinar/expire-enrollments',
    cron: '15 * * * *',
    description: 'Expire webinar enrolments whose Stripe subscription has lapsed so emails stop',
  },
  {
    id: 'webinar/zoom-rotation-reminder',
    cron: '0 8 * * 1',
    description: 'Open a Task to rotate each class Zoom link older than its rotation interval',
  },
  {
    id: 'webinar/send-recordings',
    cron: '30 * * * *',
    description:
      'Email each class its Zoom cloud recording after a session, then optionally trash it (ADR 0035, opt-in)',
  },
  {
    id: 'webinar/detect-enrollments',
    cron: '30 6 * * *',
    description: 'Scan active Stripe subscriptions and organise weekly-class payers into classes',
  },
]

