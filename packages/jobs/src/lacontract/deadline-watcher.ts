// LA contract progress-report deadline watcher. CLAUDE.md §43.3, §17.
//
// Daily 07:00 UTC. For every monthly LAContract, surface upcoming deadlines
// (within 5 working days) that have no signed report for the current period
// and (a) post a single message to #crm-tenders and (b) create a Task on
// the account lead. Idempotent on (contractId, period, day) — running it
// twice in the same UTC day is a no-op.

import { createId } from '@paralleldrive/cuid2'

import { db } from '@studymind/db'

import { inngest } from '../client'

const WARN_DAYS = 5

interface ContractRow {
  id: string
  laName: string
  reference: string
  reportingCadence: string
  accountLeadId: string | null
}

/**
 * Test-visible shape for the deadline-watcher's pure planning step.
 * The Inngest function below wires this to the DB; tests pass synthetic
 * rows in directly.
 */
export interface DeadlineCandidate {
  contractId: string
  period: string // YYYY-MM
  deadline: Date
}

export function workingDaysUntil(target: Date, now: Date): number {
  const diffMs = target.getTime() - now.getTime()
  if (diffMs <= 0) return 0
  // Approximate: 5/7 of calendar days. The deadline-watcher is a daily job
  // and the warn window (5 working days) is forgiving; we don't need a
  // calendar-aware calculator here.
  const calendarDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000))
  return Math.ceil((calendarDays * 5) / 7)
}

function periodKey(now: Date): string {
  return now.toISOString().slice(0, 7)
}

function endOfMonth(now: Date): Date {
  // Default monthly deadline = end of the calendar month.
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth()
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59))
}

/**
 * Pure planning step: which contracts are within the warning window and
 * have no signed report for the current period? Exposed for tests.
 */
export async function planDeadlineCandidates(
  contracts: ReadonlyArray<ContractRow>,
  hasSignedReport: (contractId: string, period: string) => Promise<boolean>,
  now: Date,
): Promise<DeadlineCandidate[]> {
  const out: DeadlineCandidate[] = []
  for (const c of contracts) {
    if (c.reportingCadence !== 'monthly') continue
    const deadline = endOfMonth(now)
    if (workingDaysUntil(deadline, now) > WARN_DAYS) continue
    const period = periodKey(now)
    if (await hasSignedReport(c.id, period)) continue
    out.push({ contractId: c.id, period, deadline })
  }
  return out
}

export const lacontractReportDeadlineWatcher = inngest.createFunction(
  {
    id: 'lacontract/report-deadline-watcher',
    name: 'LA contract: progress-report deadline watcher',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 7 * * *' },
  async ({ step, logger }) => {
    const now = new Date()

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

    let alerts = 0
    let tasks = 0
    const dayKey = now.toISOString().slice(0, 10)

    for (const candidate of candidates) {
      const contract = contracts.find((c) => c.id === candidate.contractId)
      if (!contract) continue

      // Idempotent task creation: dedupe on (contractId, period, day).
      const idempotencyKey = `lacontract.deadline.${candidate.contractId}.${candidate.period}.${dayKey}`

      await step.run(`alert-${candidate.contractId}`, async () => {
        // Slack outbound is wired at the worker boundary in
        // apps/web/app/api/inngest/route.ts to avoid a jobs ↔ slack cycle
        // (CLAUDE.md commit history: drift-triage relocated for the same
        // reason). Until the boundary glue is in place we log only.
        logger.info(
          {
            contractId: contract.id,
            laName: contract.laName,
            period: candidate.period,
            dedupeKey: idempotencyKey,
          },
          'lacontract.deadline.alert_pending',
        )
        alerts += 1
      })

      if (contract.accountLeadId) {
        await step.run(`task-${contract.id}`, async () => {
          // Dedupe on (assigneeId, description marker). The `referenceKey`
          // sits in description because Task has no first-class idempotency
          // column today. A future migration can promote it; the lookup
          // contract stays the same.
          const description = `__deadline_key__:${idempotencyKey}`
          const existing = await db.task.findFirst({
            where: {
              assigneeId: contract.accountLeadId,
              description,
            },
            select: { id: true },
          })
          if (existing) return
          await db.task.create({
            data: {
              id: createId(),
              assigneeId: contract.accountLeadId!,
              title: `Sign off progress report for ${contract.laName} — ${candidate.period}`,
              description,
              status: 'open',
              dueAt: candidate.deadline,
            },
          })
          tasks += 1
        })
      }
    }

    return { candidates: candidates.length, alerts, tasks }
  },
)

export const LACONTRACT_FUNCTIONS = [lacontractReportDeadlineWatcher]
