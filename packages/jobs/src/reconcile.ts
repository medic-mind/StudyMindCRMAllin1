// Cross-cutting nightly reconciliation. CLAUDE.md §17.1 (02:00 UTC), §6.3,
// §17.3 (downstream jobs wait for finance/reconcile.completed).

import { createId } from '@paralleldrive/cuid2'

import { reconcileFamily } from '@studymind/core/finance'
import { db } from '@studymind/db'

import { inngest } from './client'

const ACTIVE_STATES = ['trial', 'active', 'at_risk', 'churned'] as const

export const financeReconcileAllFamilies = inngest.createFunction(
  {
    id: 'finance/reconcile-all-families',
    name: 'Finance: nightly reconciliation across all families',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 2 * * *' },
  async ({ step, logger }) => {
    const families = await step.run('list-families', async () => {
      return db.family.findMany({
        where: { state: { in: [...ACTIVE_STATES] }, deletedAt: null },
        select: { id: true },
        take: 5_000,
      })
    })

    let totalDiscrepancies = 0
    let newlyCreated = 0

    for (const family of families) {
      const result = await step.run(`reconcile-${family.id}`, async () => {
        const { discrepancies } = await reconcileFamily(db, family.id)
        let created = 0
        for (const d of discrepancies) {
          // Idempotent on (familyId, category, contextHash) — see migration.
          const existing = await db.reconciliationDiscrepancy.findFirst({
            where: {
              familyId: d.familyId,
              category: d.category,
              contextHash: d.contextHash,
            },
            select: { id: true },
          })
          if (existing) continue
          await db.reconciliationDiscrepancy.create({
            data: {
              id: createId(),
              familyId: d.familyId,
              category: d.category,
              summary: d.summary,
              payload: d.payload as object,
              contextHash: d.contextHash,
            },
          })
          created += 1
        }
        return { discrepancies: discrepancies.length, created }
      })
      totalDiscrepancies += result.discrepancies
      newlyCreated += result.created
    }

    // §17.3 — downstream jobs (retention, churn) wait for this signal.
    await step.sendEvent('finance/reconcile.completed', {
      name: 'finance/reconcile.completed',
      data: { families: families.length, newlyCreated, totalDiscrepancies },
    })

    logger.info(
      { families: families.length, totalDiscrepancies, newlyCreated },
      'finance reconcile complete',
    )
    return { families: families.length, totalDiscrepancies, newlyCreated }
  },
)

// `aiScoreChurnRisk` lives in ./ai/churn-score.ts — replaced the stub
// that was previously inlined here.
// The legacy `complianceEnforceRetention` stub that scanned SafeguardingFlag
// rows was removed in ADR 0013; the general retention engine in
// `./compliance/enforce-retention.ts` covers emails, leads, recordings, and
// transcripts and is the only retention path.

export const RECONCILE_FUNCTIONS = [financeReconcileAllFamilies] as const
