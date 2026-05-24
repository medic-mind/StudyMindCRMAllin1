// User & Entity Behaviour Analytics (UEBA). CLAUDE.md §44.3.
//
// Weekly Mondays 04:00 UTC. Pure aggregator: takes audit-log rows for the
// prior 7 days plus a per-actor 12-week baseline, returns a categorised
// findings object. The worker boundary turns those findings into Slack
// posts and PagerDuty pages.
//
// Detections (fixed, deliberate, narrow):
//   1. off-hours DSAR exports — between 22:00–06:00 actor local time
//   2. refund clusters — > 3 refunds by the same actor in any 24h window
//   3. failed sign-in bursts — > 5 failed sign-ins from one IP in 1 hour
//
// All thresholds are constants in this file. Tuning is a code change so
// it goes through review.
//
// The safeguarding-read-spike detector was removed in ADR 0013 alongside
// the rest of the safeguarding workflow.

export const REFUND_CLUSTER_THRESHOLD = 3
export const REFUND_CLUSTER_WINDOW_MS = 24 * 60 * 60 * 1000
export const SIGNIN_BURST_THRESHOLD = 5
export const SIGNIN_BURST_WINDOW_MS = 60 * 60 * 1000

export type UebaSeverity = 'high' | 'medium' | 'low'

export interface DsarExportEvent {
  actorId: string
  /** UTC moment the export was triggered. */
  occurredAt: Date
  /** IANA timezone for the actor; default `Europe/London`. */
  actorTimezone?: string
}

export interface RefundEvent {
  actorId: string
  occurredAt: Date
}

export interface FailedSignInEvent {
  ip: string
  occurredAt: Date
}

export interface UebaInput {
  /** DSAR exports in the prior 7 days. */
  dsarExports: ReadonlyArray<DsarExportEvent>
  /** Refunds in the prior 7 days. */
  refunds: ReadonlyArray<RefundEvent>
  /** Failed sign-ins in the prior 7 days. */
  failedSignIns: ReadonlyArray<FailedSignInEvent>
  /** End of the analysis window (typically `now`). */
  windowEnd: Date
}

export interface UebaFinding {
  category:
    | 'off_hours_dsar'
    | 'refund_cluster'
    | 'signin_burst'
  severity: UebaSeverity
  summary: string
  details: Record<string, unknown>
  /** Stable id for PagerDuty dedup + Slack idempotency. */
  dedupKey: string
}

export interface UebaFindings {
  windowEnd: Date
  findings: UebaFinding[]
}

/**
 * Hour-of-day in the actor's timezone. Uses Intl to avoid pulling in a
 * full TZ library; sufficient for the 22:00–06:00 window check.
 */
export function hourInTimezone(d: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const hourPart = parts.find((p) => p.type === 'hour')
  return hourPart ? Number(hourPart.value) % 24 : d.getUTCHours()
}

function isOffHours(hour: number): boolean {
  return hour >= 22 || hour < 6
}

function detectOffHoursDsar(input: UebaInput): UebaFinding[] {
  const findings: UebaFinding[] = []
  for (const e of input.dsarExports) {
    const tz = e.actorTimezone ?? 'Europe/London'
    const hour = hourInTimezone(e.occurredAt, tz)
    if (isOffHours(hour)) {
      findings.push({
        category: 'off_hours_dsar',
        severity: 'high',
        summary: `Off-hours DSAR export by ${e.actorId} at ${hour}:00 ${tz}`,
        details: { actorId: e.actorId, hour, tz, occurredAt: e.occurredAt.toISOString() },
        dedupKey: `ueba:off_hours_dsar:${e.actorId}:${e.occurredAt.toISOString()}`,
      })
    }
  }
  return findings
}

function detectRefundClusters(input: UebaInput): UebaFinding[] {
  // Sliding window per actor: any 24h window with > threshold refunds.
  const byActor = new Map<string, RefundEvent[]>()
  for (const r of input.refunds) {
    const arr = byActor.get(r.actorId) ?? []
    arr.push(r)
    byActor.set(r.actorId, arr)
  }
  const findings: UebaFinding[] = []
  for (const [actorId, events] of byActor) {
    const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    // For each event, count how many fit within [t, t + window).
    let i = 0
    let j = 0
    let raised = false
    while (i < sorted.length && !raised) {
      const start = sorted[i]!
      while (
        j < sorted.length &&
        sorted[j]!.occurredAt.getTime() - start.occurredAt.getTime() < REFUND_CLUSTER_WINDOW_MS
      ) {
        j++
      }
      const count = j - i
      if (count > REFUND_CLUSTER_THRESHOLD) {
        const last = sorted[j - 1]!
        findings.push({
          category: 'refund_cluster',
          severity: 'medium',
          summary: `Refund cluster for ${actorId}: ${count} in 24h`,
          details: {
            actorId,
            count,
            windowStart: start.occurredAt.toISOString(),
            windowEnd: last.occurredAt.toISOString(),
          },
          dedupKey: `ueba:refund_cluster:${actorId}:${start.occurredAt.toISOString().slice(0, 10)}`,
        })
        raised = true
        break
      }
      i++
    }
  }
  return findings
}

function detectSignInBursts(input: UebaInput): UebaFinding[] {
  // Sliding window per IP.
  const byIp = new Map<string, FailedSignInEvent[]>()
  for (const e of input.failedSignIns) {
    const arr = byIp.get(e.ip) ?? []
    arr.push(e)
    byIp.set(e.ip, arr)
  }
  const findings: UebaFinding[] = []
  for (const [ip, events] of byIp) {
    const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
    let i = 0
    let j = 0
    let raised = false
    while (i < sorted.length && !raised) {
      const start = sorted[i]!
      while (
        j < sorted.length &&
        sorted[j]!.occurredAt.getTime() - start.occurredAt.getTime() < SIGNIN_BURST_WINDOW_MS
      ) {
        j++
      }
      const count = j - i
      if (count > SIGNIN_BURST_THRESHOLD) {
        const last = sorted[j - 1]!
        findings.push({
          category: 'signin_burst',
          severity: 'medium',
          summary: `Failed sign-in burst from ${ip}: ${count} in 1h`,
          details: {
            ip,
            count,
            windowStart: start.occurredAt.toISOString(),
            windowEnd: last.occurredAt.toISOString(),
          },
          dedupKey: `ueba:signin_burst:${ip}:${start.occurredAt.toISOString().slice(0, 13)}`,
        })
        raised = true
        break
      }
      i++
    }
  }
  return findings
}

/** Pure aggregator. */
export function analyseUeba(input: UebaInput): UebaFindings {
  return {
    windowEnd: input.windowEnd,
    findings: [
      ...detectOffHoursDsar(input),
      ...detectRefundClusters(input),
      ...detectSignInBursts(input),
    ],
  }
}

export function hasHighSeverity(findings: UebaFindings): boolean {
  return findings.findings.some((f) => f.severity === 'high')
}

// The Inngest registration is at the worker boundary
// (apps/web/app/api/inngest/_boundary/ueba.ts).
export const UEBA_FUNCTIONS: never[] = []
