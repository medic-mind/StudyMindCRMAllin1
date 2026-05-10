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
]

