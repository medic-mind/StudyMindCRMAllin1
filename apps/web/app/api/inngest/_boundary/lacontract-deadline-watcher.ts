// Worker boundary: LA contract progress-report deadline alerter.
// CLAUDE.md §43.3, §17, §12.
//
// The cross-cutting `lacontract/report-deadline-watcher` function in
// @studymind/jobs creates per-account-lead Tasks and logs alert intent;
// posting to Slack #crm-tenders happens here so the jobs package stays
// integration-free.
//
// Runs on the same daily 07:00 UTC cron. Idempotency on
// (yyyy-mm-dd) so multiple invocations never double-post the daily
// summary, and on (contractId, period) for the per-line items via the
// stable Slack idempotency key column.

import {
  planDeadlineCandidates,
  type DeadlineCandidate,
} from '@studymind/jobs/lacontract/deadline-watcher'
import { inngest } from '@studymind/jobs'
import { postAlert } from '@studymind/integration-slack/outbound'

import { db } from '@/lib/db'

interface ContractRow {
  id: string
  laName: string
  reference: string
  reportingCadence: string
  accountLeadId: string | null
}

function buildSummary(
  candidates: ReadonlyArray<DeadlineCandidate>,
  contracts: ReadonlyArray<ContractRow>,
): { text: string; blocks: unknown[] } {
  const lines: string[] = [
    `*LA progress-report deadlines* — ${candidates.length} contract(s) within 5 working days.`,
  ]
  for (const c of candidates) {
    const contract = contracts.find((x) => x.id === c.contractId)
    if (!contract) continue
    lines.push(
      `• ${contract.laName} (${contract.reference}) — period ${c.period}, due ${c.deadline.toISOString().slice(0, 10)}`,
    )
  }
  const text = lines.join('\n')
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines[0] },
    },
    ...(lines.length > 1
      ? [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: lines.slice(1).join('\n') },
          },
        ]
      : []),
  ]
  return { text, blocks }
}

export const lacontractDeadlineWatcherBoundary = inngest.createFunction(
  {
    id: 'lacontract/report-deadline-watcher-slack',
    name: 'LA contract: deadline-watcher Slack post (boundary)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  // Runs slightly after the in-package job to keep order deterministic.
  { cron: '5 7 * * *' },
  async ({ step, logger }) => {
    const now = new Date()
    const dayKey = now.toISOString().slice(0, 10)

    const contracts = (await step.run('list-monthly-contracts', async () =>
      db.lAContract.findMany({
        where: { deletedAt: null, reportingCadence: 'monthly' },
        select: {
          id: true,
          laName: true,
          reference: true,
          reportingCadence: true,
          accountLeadId: true,
        },
        take: 1_000,
      }),
    )) as ContractRow[]

    const candidates = await planDeadlineCandidates(
      contracts,
      async (contractId, period) => {
        const periodStart = new Date(`${period}-01T00:00:00Z`)
        const nextMonth = new Date(periodStart)
        nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
        const signed = await db.lAProgressReport.findFirst({
          where: {
            contractId,
            state: 'signed',
            periodStart: { gte: periodStart, lt: nextMonth },
          },
          select: { id: true },
        })
        return Boolean(signed)
      },
      now,
    )

    if (candidates.length === 0) {
      logger.info({ dayKey }, 'lacontract.deadline.no_candidates')
      return { posted: false, candidates: 0 }
    }

    const tendersChannel = process.env['SLACK_TENDERS_CHANNEL_ID'] ?? null
    if (!tendersChannel) {
      logger.warn(
        { dayKey, candidates: candidates.length },
        'lacontract.deadline.slack_skipped: SLACK_TENDERS_CHANNEL_ID not set',
      )
      return { posted: false, candidates: candidates.length }
    }

    const { text, blocks } = buildSummary(candidates, contracts)
    await step.run('slack-post', () =>
      postAlert({
        message: text,
        blocks,
        idempotencyKey: `lacontract.deadline.summary.${dayKey}`,
        channelId: tendersChannel,
        ctx: {
          actorId: 'system',
          requestId: `lacontract-deadline:${dayKey}`,
        },
      }),
    )

    return { posted: true, candidates: candidates.length }
  },
)
