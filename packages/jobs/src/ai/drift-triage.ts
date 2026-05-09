// Weekly drift-triage reminder. CLAUDE.md §18.3.
// Counts untriaged DriftSample rows and posts a reminder to #crm-finops.

import { postAlert } from '@studymind/integration-slack/outbound'
import { db } from '@studymind/db'

import { inngest } from '../client'

export const aiDriftTriageReminder = inngest.createFunction(
  {
    id: 'ai/drift-triage-reminder',
    name: 'AI: weekly drift-sample triage reminder',
    concurrency: { limit: 1 },
    retries: 1,
  },
  // Mondays at 09:00 UTC.
  { cron: '0 9 * * 1' },
  async ({ step, logger }) => {
    const channelId = process.env['SLACK_FINOPS_CHANNEL_ID']
    if (!channelId) {
      logger.warn('SLACK_FINOPS_CHANNEL_ID not set; skipping drift triage reminder')
      return { skipped: true }
    }

    const untriaged = await step.run('count-untriaged', async () => {
      return db.driftSample.count({ where: { reviewed: false } })
    })

    if (untriaged === 0) {
      logger.info('drift triage: zero untriaged samples')
      return { untriaged: 0, posted: false }
    }

    const weekKey = new Date().toISOString().slice(0, 10)
    await step.run('post-alert', async () => {
      await postAlert({
        message: `Drift triage: ${untriaged} AI samples await review. Triage at /admin/drift.`,
        idempotencyKey: `drift-triage:${weekKey}`,
        channelId,
        ctx: { actorId: 'system', requestId: `drift-triage:${weekKey}` },
      })
    })

    return { untriaged, posted: true }
  },
)

export const DRIFT_TRIAGE_FUNCTIONS = [aiDriftTriageReminder] as const
