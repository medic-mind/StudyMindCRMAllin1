// Direct Debit defaulter flagging (Slice B). Cross-cutting nightly logic that
// recomputes the defaulter set and raises a `direct_debit_default`
// ReconciliationDiscrepancy for any newly-defaulted family. CLAUDE.md §6.3,
// §9, §17.1. Read-only analysis — never auto-charges or auto-duns (§3).
//
// The pure aggregator lives here; the Slack #crm-finops notification glue
// lives at the worker boundary (apps/web/app/api/inngest/_boundary) to avoid a
// jobs → integrations import cycle, mirroring the cost-summary pattern.

import { createHash } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'

import {
  listActivePlanArrears,
  listDefaulters,
  listPlanShortfalls,
  type ActivePlanArrearsWithCustomer,
  type DefaulterRow,
  type PlanShortfallWithCustomer,
} from '@studymind/core/finance'
import type { Prisma, PrismaClient } from '@studymind/db'

export type DbClient = PrismaClient | Prisma.TransactionClient

/**
 * Stable per-family discrepancy key. Keyed on the family and the sorted reason
 * set so a family whose default reasons change re-surfaces as a fresh
 * discrepancy, but a re-run with no change is a no-op (idempotent on the
 * unique (familyId, category, contextHash) index).
 */
export function defaulterContextHash(row: DefaulterRow): string {
  const h = createHash('sha256')
  h.update(['direct_debit_default', row.familyId, [...row.reasons].sort().join(',')].join('|'))
  return h.digest('hex').slice(0, 32)
}

export interface NewlyDefaulted {
  familyId: string
  billingContactName: string | null
  outstandingMinor: number
  reasons: string[]
}

export interface FlagDefaultersResult {
  scanned: number
  newlyDefaulted: NewlyDefaulted[]
}

/**
 * Recompute the defaulter set and upsert discrepancies. Returns the families
 * that were newly flagged on this run (so the caller can notify finops).
 */
export async function flagDefaulters(
  db: DbClient,
  now: Date = new Date(),
): Promise<FlagDefaultersResult> {
  const defaulters = await listDefaulters(db, { now })
  const newlyDefaulted: NewlyDefaulted[] = []

  for (const row of defaulters) {
    const contextHash = defaulterContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: {
        familyId: row.familyId,
        category: 'direct_debit_default',
        contextHash,
      },
      select: { id: true },
    })
    if (existing) continue

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_default',
        summary: `Direct Debit default — ${row.reasons.join(', ')}; outstanding ${row.outstandingMinor}p`,
        payload: {
          reasons: row.reasons,
          mandateStatus: row.mandateStatus,
          failedCount: row.failedCount,
          totalPaidMinor: row.totalPaidMinor,
          totalOwedMinor: row.totalOwedMinor,
          outstandingMinor: row.outstandingMinor,
          billingContactName: row.billingContactName,
        },
        contextHash,
      },
    })

    newlyDefaulted.push({
      familyId: row.familyId,
      billingContactName: row.billingContactName,
      outstandingMinor: row.outstandingMinor,
      reasons: row.reasons,
    })
  }

  return { scanned: defaulters.length, newlyDefaulted }
}

// -----------------------------------------------------------------------------
// Plan-level issues (ADR 0038, sixth amendment): cancelled-part-way / underpaid
// plans and active plans behind their collection schedule. These complement the
// family-level defaulter scan above. A discrepancy is family-scoped, so we only
// raise one when the plan's GoCardless customer is linked to a Family; unlinked
// plans still surface in the Direct Debits workspace for a human to link.
// Read-only — never auto-charges (§3).
// -----------------------------------------------------------------------------

/** Stable per-plan discrepancy key for a shortfall (terminal — value is stable). */
export function planShortfallContextHash(row: PlanShortfallWithCustomer): string {
  const h = createHash('sha256')
  h.update(['plan_shortfall', row.gcSubscriptionId, [...row.reasons].sort().join(',')].join('|'))
  return h.digest('hex').slice(0, 32)
}

/** Stable per-plan discrepancy key for arrears (one flag per plan; re-arms only
 * after the open discrepancy is resolved, so a worsening plan does not spam). */
export function planArrearsContextHash(row: ActivePlanArrearsWithCustomer): string {
  const h = createHash('sha256')
  h.update(['plan_arrears', row.gcSubscriptionId].join('|'))
  return h.digest('hex').slice(0, 32)
}

export interface NewlyFlaggedPlan {
  gcSubscriptionId: string
  familyId: string
  customerName: string | null
  amountDueMinor: number
  kind: 'shortfall' | 'arrears'
}

export interface FlagPlanIssuesResult {
  shortfallsScanned: number
  arrearsScanned: number
  newlyFlagged: NewlyFlaggedPlan[]
}

/**
 * Recompute plan shortfalls + active arrears and upsert a discrepancy for each
 * family-linked plan, idempotent on (familyId, category, contextHash). Returns
 * the plans newly flagged this run so the caller can notify finops.
 */
export async function flagPlanIssues(
  db: DbClient,
  now: Date = new Date(),
): Promise<FlagPlanIssuesResult> {
  const [shortfalls, arrears] = await Promise.all([
    listPlanShortfalls(db),
    listActivePlanArrears(db, { now }),
  ])
  const newlyFlagged: NewlyFlaggedPlan[] = []

  for (const row of shortfalls) {
    if (!row.familyId) continue
    const contextHash = planShortfallContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: { familyId: row.familyId, category: 'direct_debit_plan_shortfall', contextHash },
      select: { id: true },
    })
    if (existing) continue

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_plan_shortfall',
        summary: `Plan ${row.cancelledPartway ? 'cancelled part-way' : 'underpaid'} — ${row.collectedCount}/${row.totalPaymentCount} collected, ${row.shortfallMinor}p still due`,
        payload: {
          gcSubscriptionId: row.gcSubscriptionId,
          name: row.name,
          status: row.status,
          reasons: row.reasons,
          totalPaymentCount: row.totalPaymentCount,
          collectedCount: row.collectedCount,
          expectedTotalMinor: row.expectedTotalMinor,
          collectedMinor: row.collectedMinor,
          shortfallMinor: row.shortfallMinor,
          customerName: row.customerName,
          contactId: row.contactId,
        },
        contextHash,
      },
    })
    newlyFlagged.push({
      gcSubscriptionId: row.gcSubscriptionId,
      familyId: row.familyId,
      customerName: row.customerName,
      amountDueMinor: row.shortfallMinor,
      kind: 'shortfall',
    })
  }

  for (const row of arrears) {
    if (!row.familyId) continue
    const contextHash = planArrearsContextHash(row)
    const existing = await db.reconciliationDiscrepancy.findFirst({
      where: { familyId: row.familyId, category: 'direct_debit_plan_arrears', contextHash },
      select: { id: true },
    })
    if (existing) continue

    await db.reconciliationDiscrepancy.create({
      data: {
        id: createId(),
        familyId: row.familyId,
        category: 'direct_debit_plan_arrears',
        summary: `Active plan behind schedule — ${row.collectedCount}/${row.expectedByNow} collected, ~${row.estimatedArrearsMinor}p in arrears`,
        payload: {
          gcSubscriptionId: row.gcSubscriptionId,
          name: row.name,
          missedCount: row.missedCount,
          expectedByNow: row.expectedByNow,
          collectedCount: row.collectedCount,
          estimatedArrearsMinor: row.estimatedArrearsMinor,
          customerName: row.customerName,
          contactId: row.contactId,
        },
        contextHash,
      },
    })
    newlyFlagged.push({
      gcSubscriptionId: row.gcSubscriptionId,
      familyId: row.familyId,
      customerName: row.customerName,
      amountDueMinor: row.estimatedArrearsMinor,
      kind: 'arrears',
    })
  }

  return {
    shortfallsScanned: shortfalls.length,
    arrearsScanned: arrears.length,
    newlyFlagged,
  }
}
