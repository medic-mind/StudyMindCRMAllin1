// Cross-cutting nightly reconciliation. CLAUDE.md §17.1 (02:00 UTC), §6.3,
// §17.3 (downstream jobs wait for finance/reconcile.completed).

import { createId } from '@paralleldrive/cuid2'

import { reconcileFamily } from '@studymind/core/finance'
import { isExpired, listSafeguardingRetentionRows } from '@studymind/core/safeguarding'
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

// -----------------------------------------------------------------------------
// Downstream stubs that wait for finance/reconcile.completed (§17.3).
// They are no-ops today; the real implementations land in their own slices
// (compliance/enforce-retention, ai/score-churn-risk).
// -----------------------------------------------------------------------------

export const complianceEnforceRetention = inngest.createFunction(
  {
    id: 'compliance/enforce-retention',
    name: 'Compliance: enforce retention (safeguarding)',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: 'finance/reconcile.completed' },
  async ({ logger, step }) => {
    // Walk every active SafeguardingFlag and apply effectiveRetention.
    // CLAUDE.md §21 retention table; safeguarding default is 25y from DOB,
    // overridable per LAContract.
    const serialisedRows = await step.run('list-safeguarding-rows', async () => {
      const r = await listSafeguardingRetentionRows(db)
      return r.map((row) => ({
        flagId: row.flagId,
        contactId: row.contactId,
        contactDob: row.contactDob ? row.contactDob.toISOString() : null,
        flagCreatedAt: row.flagCreatedAt.toISOString(),
        contractOverrideDays: row.contractOverrideDays,
      }))
    })
    const rows = serialisedRows.map((row) => ({
      flagId: row.flagId,
      contactId: row.contactId,
      contactDob: row.contactDob ? new Date(row.contactDob) : null,
      flagCreatedAt: new Date(row.flagCreatedAt),
      contractOverrideDays: row.contractOverrideDays,
    }))
    let softDeleted = 0
    let hardDeleted = 0
    const systemDefaultDays = 7 * 365
    const now = new Date()

    for (const r of rows) {
      const expired = isExpired({
        flagId: r.flagId,
        contactDob: r.contactDob,
        defaultDays: systemDefaultDays,
        contractOverrideDays: r.contractOverrideDays ?? null,
        createdAt: r.flagCreatedAt,
        now,
      })
      if (!expired) continue

      // CLAUDE.md §21: soft delete first, then hard delete after grace period.
      // The grace is enforced by the retention engine itself: a row already
      // soft-deleted long enough is hard-deleted on this pass.
      const result = await step.run(`retain-${r.flagId}`, async () => {
        const flag = await db.safeguardingFlag.findUnique({
          where: { id: r.flagId },
          select: { id: true, deletedAt: true },
        })
        if (!flag) return { kind: 'gone' as const }
        if (!flag.deletedAt) {
          await db.safeguardingFlag.update({
            where: { id: r.flagId },
            data: { deletedAt: now },
          })
          return { kind: 'soft' as const }
        }
        // Soft-deleted at least 30 days — hard delete + crypto-shred.
        const graceMs = 30 * 24 * 60 * 60 * 1000
        if (now.getTime() - flag.deletedAt.getTime() < graceMs) {
          return { kind: 'in_grace' as const }
        }
        await db.encryptedField.deleteMany({
          where: { contactId: r.contactId, column: { startsWith: 'safeguarding_body:' } },
        })
        await db.safeguardingFlag.delete({ where: { id: r.flagId } })
        return { kind: 'hard' as const }
      })
      if (result.kind === 'soft') softDeleted += 1
      if (result.kind === 'hard') hardDeleted += 1
    }

    logger.info(
      { scanned: rows.length, softDeleted, hardDeleted },
      'compliance.enforce_retention.completed',
    )
    return { scanned: rows.length, softDeleted, hardDeleted }
  },
)

// `aiScoreChurnRisk` lives in ./ai/churn-score.ts — replaced the stub
// that was previously inlined here.

export const RECONCILE_FUNCTIONS = [
  financeReconcileAllFamilies,
  complianceEnforceRetention,
] as const
