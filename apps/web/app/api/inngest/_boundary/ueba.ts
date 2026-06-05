// Worker boundary: weekly UEBA detection. CLAUDE.md §44.3.
//
// Runs Mondays 04:00 UTC. Pulls audit-log rows for the prior 7 days and
// invokes the pure analyser. Findings are posted to #crm-incidents and (if
// any High severity) page on-call via PagerDuty.
//
// The safeguarding-read-spike detector was removed in ADR 0013.

import {
  analyseUeba,
  hasHighSeverity,
  type DsarExportEvent,
  type FailedSignInEvent,
  type RefundEvent,
} from '@studymind/jobs/security/ueba'
import { resolveTopicChannelId } from '@studymind/core/slack'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'
import { triggerEvent } from '@studymind/integration-pagerduty/client'

import { db } from '@/lib/db'

const WINDOW_DAYS = 7

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

    const inputs = await step.run('collect', async () => {
      const windowRows = await db.auditLogEntry.findMany({
        where: { occurredAt: { gte: windowStart, lte: now } },
        select: { action: true, actorId: true, occurredAt: true, after: true },
        take: 50_000,
      })
      return { windowRows }
    })

    const dsarExports: DsarExportEvent[] = []
    const refunds: RefundEvent[] = []
    const failedSignIns: FailedSignInEvent[] = []

    for (const r of inputs.windowRows) {
      const occurredAt = new Date(r.occurredAt)
      if (r.actorId && r.action === 'dsar.exported') {
        dsarExports.push({ actorId: r.actorId, occurredAt })
      } else if (r.actorId && r.action === 'charge.refunded') {
        refunds.push({ actorId: r.actorId, occurredAt })
      } else if (r.action === 'auth.signin_failed') {
        const ip = (r.after as { ip?: string } | null)?.ip
        if (ip) failedSignIns.push({ ip, occurredAt })
      }
    }

    const findings = analyseUeba({
      dsarExports,
      refunds,
      failedSignIns,
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
    const incidentsChannel = await resolveTopicChannelId(
      db,
      'security_alerts',
      process.env['SLACK_INCIDENTS_CHANNEL_ID'] ?? null,
    )
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
