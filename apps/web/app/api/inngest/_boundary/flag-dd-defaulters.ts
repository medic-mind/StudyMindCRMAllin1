// Worker boundary for the nightly Direct Debit issue scan (Slice B + ADR 0038
// sixth amendment). CLAUDE.md §6.3, §9, §17.1, §3 (read-only — never auto-chases).
//
// The pure aggregators (recompute the defaulter set, plan shortfalls and active
// arrears + raise discrepancies) live in
// `@studymind/jobs/finance/flag-dd-defaulters`; the Slack #crm-finops glue lives
// here so `packages/jobs` does not import `packages/integrations`, mirroring the
// cost-summary boundary.
//
// Runs after `finance/reconcile-all-families` completes (§17.3) so the
// invoice/payment state it reads is consistent.

import { resolveTopicChannelId } from '@studymind/core/slack'
import { flagDefaulters, flagPlanIssues } from '@studymind/jobs/finance/flag-dd-defaulters'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'

import { db } from '@/lib/db'

function buildSlackText(
  newlyDefaulted: number,
  newlyShortfall: number,
  newlyArrears: number,
): { text: string; blocks: unknown[] } {
  const parts: string[] = []
  if (newlyDefaulted > 0) parts.push(`${newlyDefaulted} defaulter family(ies)`)
  if (newlyShortfall > 0) parts.push(`${newlyShortfall} cancelled/underpaid plan(s)`)
  if (newlyArrears > 0) parts.push(`${newlyArrears} plan(s) behind schedule`)
  const summary = parts.join(' · ')
  const text = `Direct Debit issues: ${summary} need finance attention.`
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Direct Debit issues*\n${summary} — see Direct Debits → Issues in the CRM.`,
      },
    },
  ]
  return { text, blocks }
}

export const flagDdDefaultersNightly = inngest.createFunction(
  {
    id: 'finance/flag-dd-defaulters',
    name: 'Finance: nightly Direct Debit issue scan (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  // Wait for the nightly reconcile to finish before recomputing so we read
  // consistent invoice/payment state (§17.3). The reconcile job emits
  // `finance/reconcile.completed`.
  { event: 'finance/reconcile.completed' },
  async ({ step, logger }) => {
    const result = await step.run('flag-defaulters', () => flagDefaulters(db))
    const planResult = await step.run('flag-plan-issues', () => flagPlanIssues(db))

    const newlyShortfall = planResult.newlyFlagged.filter((p) => p.kind === 'shortfall').length
    const newlyArrears = planResult.newlyFlagged.filter((p) => p.kind === 'arrears').length
    const totalNewly = result.newlyDefaulted.length + planResult.newlyFlagged.length

    // Notify finops only when there is something newly flagged, and only when
    // the channel is configured. Idempotency key is the UTC day so retries do
    // not double-post.
    const finopsChannel = await resolveTopicChannelId(
      db,
      'finance_dd_defaulters',
      process.env['SLACK_FINOPS_CHANNEL_ID'] ?? null,
    )
    if (totalNewly > 0 && finopsChannel) {
      const dayKey = new Date().toISOString().slice(0, 10)
      const { text, blocks } = buildSlackText(
        result.newlyDefaulted.length,
        newlyShortfall,
        newlyArrears,
      )
      await step.run('slack-post', () =>
        postAlert({
          message: text,
          blocks,
          idempotencyKey: `dd-issues:${dayKey}`,
          channelId: finopsChannel,
          ctx: {
            actorId: 'system',
            requestId: `dd-issues:${dayKey}`,
          },
        }),
      )
    } else if (totalNewly > 0) {
      logger.warn(
        { totalNewly },
        'dd_issues.slack_skipped: SLACK_FINOPS_CHANNEL_ID not set',
      )
    }

    logger.info(
      {
        scanned: result.scanned,
        newlyDefaulted: result.newlyDefaulted.length,
        shortfallsScanned: planResult.shortfallsScanned,
        arrearsScanned: planResult.arrearsScanned,
        newlyShortfall,
        newlyArrears,
      },
      'finance dd-issue scan complete',
    )
    return {
      scanned: result.scanned,
      newlyDefaulted: result.newlyDefaulted.length,
      newlyShortfall,
      newlyArrears,
    }
  },
)
