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

import { listDefaulters, type DefaulterRow } from '@studymind/core/finance'
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
