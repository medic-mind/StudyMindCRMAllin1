// Worker boundary for the nightly Direct Debit defaulter scan (Slice B).
// CLAUDE.md §6.3, §9, §17.1, §3 (read-only — never auto-chases).
//
// The pure aggregator (recompute defaulter set + raise discrepancies) lives in
// `@studymind/jobs/finance/flag-dd-defaulters`; the Slack #crm-finops glue
// lives here so `packages/jobs` does not import `packages/integrations`,
// mirroring the cost-summary boundary.
//
// Runs after `finance/reconcile-all-families` completes (§17.3) so the
// invoice/payment state it reads is consistent.

import { resolveTopicChannelId } from '@studymind/core/slack'
import { flagDefaulters } from '@studymind/jobs/finance/flag-dd-defaulters'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'

import { db } from '@/lib/db'

function buildSlackText(newlyDefaulted: number): { text: string; blocks: unknown[] } {
  const text = `Direct Debit defaulters: ${newlyDefaulted} newly-flagged family(ies) need finance attention.`
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Direct Debit defaulters*\n${newlyDefaulted} newly-flagged family(ies) — see Finance → Direct Debit issues.`,
      },
    },
  ]
  return { text, blocks }
}

export const flagDdDefaultersNightly = inngest.createFunction(
  {
    id: 'finance/flag-dd-defaulters',
    name: 'Finance: nightly Direct Debit defaulter scan (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  // Wait for the nightly reconcile to finish before recomputing defaulters so
  // we read consistent invoice/payment state (§17.3). The reconcile job emits
  // `finance/reconcile.completed`.
  { event: 'finance/reconcile.completed' },
  async ({ step, logger }) => {
    const result = await step.run('flag-defaulters', () => flagDefaulters(db))

    // Notify finops only when there are newly-flagged families, and only when
    // the channel is configured. Idempotency key is the UTC day so retries do
    // not double-post.
    const finopsChannel = await resolveTopicChannelId(
      db,
      'finance_dd_defaulters',
      process.env['SLACK_FINOPS_CHANNEL_ID'] ?? null,
    )
    if (result.newlyDefaulted.length > 0 && finopsChannel) {
      const dayKey = new Date().toISOString().slice(0, 10)
      const { text, blocks } = buildSlackText(result.newlyDefaulted.length)
      await step.run('slack-post', () =>
        postAlert({
          message: text,
          blocks,
          idempotencyKey: `dd-defaulters:${dayKey}`,
          channelId: finopsChannel,
          ctx: {
            actorId: 'system',
            requestId: `dd-defaulters:${dayKey}`,
          },
        }),
      )
    } else if (result.newlyDefaulted.length > 0) {
      logger.warn(
        { newlyDefaulted: result.newlyDefaulted.length },
        'dd_defaulters.slack_skipped: SLACK_FINOPS_CHANNEL_ID not set',
      )
    }

    logger.info(
      { scanned: result.scanned, newlyDefaulted: result.newlyDefaulted.length },
      'finance dd-defaulter scan complete',
    )
    return { scanned: result.scanned, newlyDefaulted: result.newlyDefaulted.length }
  },
)
