// Worker boundary: weekly UEBA detection. CLAUDE.md §44.3.
//
// Runs Mondays 04:00 UTC. Pulls audit-log rows for the prior 7 days, looks
// up a 12-week baseline of weekly safeguarding-read counts per actor, and
// invokes the pure analyser. Findings are posted to #crm-incidents and (if
// any High severity) page on-call via PagerDuty.

import {
  analyseUeba,
  hasHighSeverity,
  type DsarExportEvent,
  type FailedSignInEvent,
  type RefundEvent,
  type SafeguardingReadEvent,
} from '@studymind/jobs/security/ueba'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'
import { triggerEvent } from '@studymind/integration-pagerduty/client'

import { db } from '@/lib/db'

const WINDOW_DAYS = 7
const BASELINE_WEEKS = 12

interface AuditRow {
  actorId: string | null
  action: string
  occurredAt: Date
  after: unknown
}

function bucketWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() - (day - 1))
  return t.toISOString().slice(0, 10)
}

function buildBaseline(rows: ReadonlyArray<AuditRow>): Record<string, number[]> {
  const byActorWeek = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!r.actorId) continue
    const week = bucketWeek(r.occurredAt)
    const inner = byActorWeek.get(r.actorId) ?? new Map<string, number>()
    inner.set(week, (inner.get(week) ?? 0) + 1)
    byActorWeek.set(r.actorId, inner)
  }
  const out: Record<string, number[]> = {}
  for (const [actor, inner] of byActorWeek) {
    out[actor] = Array.from(inner.values())
  }
  return out
}

export const uebaWeekly = inngest.createFunction(
  {
    id: 'security/ueba-weekly',
    name: 'Security: UEBA weekly detection (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 4 * * 1' },
  async ({ step, logger }) => {
    const now = new Date()
    const windowStart = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000)
    const baselineStart = new Date(now.getTime() - BASELINE_WEEKS * 7 * 24 * 60 * 60 * 1000)

    const inputs = await step.run('collect', async () => {
      const [windowRows, baselineRows] = await Promise.all([
        db.auditLogEntry.findMany({
          where: { occurredAt: { gte: windowStart, lte: now } },
          select: { action: true, actorId: true, occurredAt: true, after: true },
          take: 50_000,
        }),
        db.auditLogEntry.findMany({
          where: {
            occurredAt: { gte: baselineStart, lt: windowStart },
            action: { in: ['safeguarding.field_decrypted', 'safeguarding.read_attempt'] },
          },
          select: { action: true, actorId: true, occurredAt: true, after: true },
          take: 200_000,
        }),
      ])
      return { windowRows, baselineRows }
    })

    const safeguardingReads: SafeguardingReadEvent[] = []
    const dsarExports: DsarExportEvent[] = []
    const refunds: RefundEvent[] = []
    const failedSignIns: FailedSignInEvent[] = []

    for (const r of inputs.windowRows) {
      const occurredAt = new Date(r.occurredAt)
      if (
        r.actorId &&
        (r.action === 'safeguarding.field_decrypted' ||
          r.action === 'safeguarding.read_attempt')
      ) {
        safeguardingReads.push({ actorId: r.actorId, occurredAt })
      } else if (r.actorId && r.action === 'dsar.exported') {
        dsarExports.push({ actorId: r.actorId, occurredAt })
      } else if (r.actorId && r.action === 'charge.refunded') {
        refunds.push({ actorId: r.actorId, occurredAt })
      } else if (r.action === 'auth.signin_failed') {
        const ip = (r.after as { ip?: string } | null)?.ip
        if (ip) failedSignIns.push({ ip, occurredAt })
      }
    }

    const baseline = buildBaseline(inputs.baselineRows.map((r) => ({
      actorId: r.actorId,
      action: r.action,
      occurredAt: new Date(r.occurredAt),
      after: r.after,
    })))

    const findings = analyseUeba({
      safeguardingReads,
      dsarExports,
      refunds,
      failedSignIns,
      safeguardingReadBaseline: baseline,
      windowEnd: now,
    })

    logger.info(
      { count: findings.findings.length, windowEnd: now.toISOString() },
      'ueba.completed',
    )

    if (findings.findings.length === 0) {
      return { count: 0 }
    }

    // Slack: one post per finding to #crm-incidents.
    const incidentsChannel = process.env['SLACK_INCIDENTS_CHANNEL_ID'] ?? null
    for (const f of findings.findings) {
      if (incidentsChannel) {
        await step.run(`slack-${f.dedupKey}`, () =>
          postAlert({
            channelId: incidentsChannel,
            message: `[UEBA ${f.severity}] ${f.summary}`,
            idempotencyKey: f.dedupKey,
            ctx: { actorId: 'system', requestId: `ueba:${f.dedupKey}` },
          }),
        )
      }
    }

    // PagerDuty: page on any High severity.
    if (hasHighSeverity(findings)) {
      await step.run('pagerduty', () =>
        triggerEvent({
          summary: `UEBA: ${findings.findings.filter((f) => f.severity === 'high').length} high-severity finding(s)`,
          severity: 'error',
          dedupKey: `ueba:${now.toISOString().slice(0, 10)}`,
          source: 'studymind-crm-ueba',
          details: {
            count: findings.findings.length,
            categories: Array.from(new Set(findings.findings.map((f) => f.category))),
          },
        }),
      )
    }

    return { count: findings.findings.length }
  },
)
