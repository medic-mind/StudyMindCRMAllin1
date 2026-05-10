// Observability cross-cutting jobs. CLAUDE.md §25, Slice 14.
//
// SLO monitor and cron watchdog are pure detectors — the Inngest function
// wiring lives at the worker boundary (apps/web/app/api/inngest/_boundary/)
// so this package stays free of provider SDKs (Slack, PagerDuty).

export { detectSloViolations } from './slo-monitor'
export type {
  AxiomReader,
  SloMonitorClock,
  SloName,
  SloViolation,
} from './slo-monitor'

export { detectCronMisses } from './cron-watchdog'
export type {
  CronExpectation,
  CronMiss,
  CronStatusReader,
  MissSeverity,
} from './cron-watchdog'

export const OBSERVABILITY_FUNCTIONS: never[] = []
