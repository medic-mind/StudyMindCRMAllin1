// SLO violation detector. CLAUDE.md §25.1, Slice 14.
//
// Pure function: given an Axiom-shaped query result reader and a clock,
// returns the list of SLO violations to alert on. The Inngest function and
// the Slack/PagerDuty boundary are wired separately so this module stays
// testable without network or queues.
//
// SLOs we currently watch (CLAUDE.md §25.1):
//   - web_availability       (rolling 1h, target 99.9%)
//   - webhook_2xx_rate       per provider, rolling 1h, target 99.95%
//   - webhook_to_db_latency  90p across providers, rolling 1h, target 30000 ms
//   - inngest_function_success_rate  rolling 1h, target 99.5%

import type { AxiomQueryResult } from '@studymind/core/observability/axiom-query'

export interface SloMonitorClock {
  now(): Date
}

export interface AxiomReader {
  query(apl: string, startTime: Date, endTime: Date): Promise<AxiomQueryResult>
}

export type SloName =
  | 'web_availability'
  | 'webhook_2xx_rate'
  | 'webhook_to_db_latency_p90'
  | 'inngest_function_success_rate'

export interface SloViolation {
  slo: SloName
  /** Rolling-window key — used by the boundary for de-duplication. */
  period: string
  /** Provider for per-provider SLOs (webhook_2xx_rate). */
  scope?: string
  /** The measured value. */
  value: number
  /** The configured threshold the value violated. */
  threshold: number
  /** Sev mapping per CLAUDE.md §25.2; we default to Sev 2 for SLO breach. */
  severity: 'critical' | 'error' | 'warning'
}

const HOUR = 60 * 60 * 1000

function periodKey(now: Date, slo: SloName, scope?: string): string {
  const hour = new Date(now)
  hour.setMinutes(0, 0, 0)
  return `${slo}:${scope ?? '*'}:${hour.toISOString()}`
}

/**
 * Check every SLO once. Returns an empty list when all SLOs are within budget.
 *
 * The function tolerates an Axiom that returns no rows (cold dataset, brand
 * new env): with no signal we cannot conclude a breach, so we return [].
 */
export async function detectSloViolations(
  axiom: AxiomReader,
  clock: SloMonitorClock = { now: () => new Date() },
): Promise<SloViolation[]> {
  const now = clock.now()
  const start = new Date(now.getTime() - HOUR)
  const violations: SloViolation[] = []

  // 1. Web availability. We treat any 5xx on an app route as a failure.
  {
    const apl = `['web-logs'] | where _time >= datetime_${start.toISOString()} | summarize total = count(), errors = countif(status >= 500)`
    const res = await axiom.query(apl, start, now)
    const row = res.rows[0]
    if (row) {
      const total = Number(row['total'] ?? 0)
      const errors = Number(row['errors'] ?? 0)
      if (total > 0) {
        const availability = 1 - errors / total
        if (availability < 0.999) {
          violations.push({
            slo: 'web_availability',
            period: periodKey(now, 'web_availability'),
            value: availability,
            threshold: 0.999,
            severity: 'error',
          })
        }
      }
    }
  }

  // 2. Webhook 2xx rate per provider.
  {
    const apl = `['webhook-receive'] | summarize total = count(), nonok = countif(status >= 400) by provider`
    const res = await axiom.query(apl, start, now)
    for (const row of res.rows) {
      const total = Number(row['total'] ?? 0)
      const nonok = Number(row['nonok'] ?? 0)
      const provider = String(row['provider'] ?? 'unknown')
      if (total > 0) {
        const rate = 1 - nonok / total
        if (rate < 0.9995) {
          violations.push({
            slo: 'webhook_2xx_rate',
            scope: provider,
            period: periodKey(now, 'webhook_2xx_rate', provider),
            value: rate,
            threshold: 0.9995,
            severity: 'error',
          })
        }
      }
    }
  }

  // 3. Webhook → DB end-to-end latency 90p.
  {
    const apl = `['webhook-to-db'] | summarize p90 = percentile(latencyMs, 90)`
    const res = await axiom.query(apl, start, now)
    const row = res.rows[0]
    if (row) {
      const p90 = Number(row['p90'] ?? 0)
      if (p90 > 30_000) {
        violations.push({
          slo: 'webhook_to_db_latency_p90',
          period: periodKey(now, 'webhook_to_db_latency_p90'),
          value: p90,
          threshold: 30_000,
          severity: 'warning',
        })
      }
    }
  }

  // 4. Inngest function success rate.
  {
    const apl = `['inngest-runs'] | summarize total = count(), failed = countif(success == false)`
    const res = await axiom.query(apl, start, now)
    const row = res.rows[0]
    if (row) {
      const total = Number(row['total'] ?? 0)
      const failed = Number(row['failed'] ?? 0)
      if (total > 0) {
        const successRate = 1 - failed / total
        if (successRate < 0.995) {
          violations.push({
            slo: 'inngest_function_success_rate',
            period: periodKey(now, 'inngest_function_success_rate'),
            value: successRate,
            threshold: 0.995,
            severity: 'error',
          })
        }
      }
    }
  }

  return violations
}
