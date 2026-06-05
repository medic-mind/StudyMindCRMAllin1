// Worker boundary for the weekly cost summary. CLAUDE.md §32, §17.
//
// `packages/jobs` cannot import from `packages/integrations` without
// creating a cycle, so the pure aggregator (S3-archived markdown) lives
// in `@studymind/jobs/cost-summary` and the integration glue (S3 put,
// signed URL, Slack post) lives here at the worker boundary.
//
// Replaces the in-package `costSummaryFunction` registration. The cron
// fires Mondays 09:00 UTC; idempotency keys derive from the ISO week so
// retries do not double-post.

import {
  putCostReport,
  signCostReportUrl,
} from '@studymind/core/observability/cost-reports-s3'
import {
  aggregateCostSummary,
  collectCostInputs,
  costSummaryS3Key,
  renderCostMarkdown,
  type CostDbReader,
} from '@studymind/jobs/cost-summary'
import { resolveTopicChannelId } from '@studymind/core/slack'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'

import { db } from '@/lib/db'

/**
 * Build a one-paragraph headline for Slack. Keeps the post readable in the
 * channel preview without revealing per-task figures.
 */
function buildSlackText(weekIso: string, aiTotalUsd: number, signedUrl: string): {
  text: string
  blocks: unknown[]
} {
  const text = `Cost summary ${weekIso} — AI total $${aiTotalUsd.toFixed(2)}. Report: ${signedUrl}`
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Weekly cost summary — ${weekIso}*\nAI total: *$${aiTotalUsd.toFixed(2)}*`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open report (7-day signed link)' },
          url: signedUrl,
        },
      ],
    },
  ]
  return { text, blocks }
}

export const costSummaryWeekly = inngest.createFunction(
  {
    id: 'cost/weekly-summary',
    name: 'Cost: weekly AI + storage summary (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 9 * * 1' },
  async ({ step, logger }) => {
    const now = new Date()

    const inputs = await step.run('collect', () =>
      collectCostInputs(db as unknown as CostDbReader, now),
    )

    const summary = aggregateCostSummary({
      samples: inputs.samples.map((s) => ({
        task: s.task,
        costUsd: s.costUsd,
        sampledAt: new Date(s.sampledAt),
      })),
      storage: inputs.storage,
      now,
    })
    const md = renderCostMarkdown(summary)

    // 1) Persist to S3.
    const { s3Key } = await step.run('s3-put', () =>
      putCostReport({ weekIso: summary.weekIso, markdown: md }),
    )

    // 2) Sign for 7 days. CLAUDE.md §32.
    const signedUrl = await step.run('s3-sign', () =>
      signCostReportUrl(s3Key, 7 * 24 * 60 * 60),
    )

    // 3) Post to #crm-finops (override the default alerts channel).
    const finopsChannel = await resolveTopicChannelId(
      db,
      'cost_summary',
      process.env['SLACK_FINOPS_CHANNEL_ID'] ?? null,
    )
    if (finopsChannel) {
      const { text, blocks } = buildSlackText(summary.weekIso, summary.aiTotalUsd, signedUrl)
      await step.run('slack-post', () =>
        postAlert({
          message: text,
          blocks,
          idempotencyKey: `cost-summary:${summary.weekIso}`,
          channelId: finopsChannel,
          ctx: {
            actorId: 'system',
            requestId: `cost-summary:${summary.weekIso}`,
          },
        }),
      )
    } else {
      logger.warn(
        { weekIso: summary.weekIso },
        'cost.summary.slack_skipped: SLACK_FINOPS_CHANNEL_ID not set',
      )
    }

    logger.info(
      {
        weekIso: summary.weekIso,
        aiTotalUsd: summary.aiTotalUsd,
        s3Key: costSummaryS3Key(summary.weekIso),
      },
      'cost.summary.archived',
    )

    return {
      s3Key,
      weekIso: summary.weekIso,
      aiTotalUsd: summary.aiTotalUsd,
    }
  },
)
