// Automatic duplicate-contact merging (ADR 0047 — operator-authorised, an
// explicit exception to the §3 "humans confirm every merge" rule).
//
// We only auto-merge contacts that are *confidently the same person* — a shared
// email, or a shared phone AND matching name (a shared family landline alone is
// never enough, §41.1). The decision is the pure `planAutoMerges`; this service
// does the I/O: load candidate contacts, run each plan through the audited
// `mergeContacts`, skip (never fail) on a restricted-access conflict so the
// unattended job leaves those for a human. Genuinely ambiguous duplicates that
// this declines to touch still surface on `/contacts/duplicates` for manual
// review.
//
// Shared by the recurring `contacts/auto-merge-duplicates` cron and the
// Manager+ "Run now" tRPC action.

import type { PrismaClient } from '@prisma/client'

import { planAutoMerges } from '@studymind/core/contact'
import { writeAuditLogEntry } from '@studymind/audit'

import { mergeContacts } from './contact-merge'

// Bound the load so one tick stays cheap regardless of table size.
const SCAN_LIMIT = 20000
// Backstop against a runaway batch; real duplicate sets are far smaller.
const MAX_MERGES_PER_RUN = 1000

export interface AutoMergeResult {
  scanned: number
  clustersMerged: number
  merged: number
  skipped: number
}

/**
 * Find and merge confident duplicate contacts.
 *
 * @param actorId      audit actor — a user id (Run now) or `system:<job>` (cron).
 * @param actorUserId  FK written to `Contact.updatedById`; null for a system run.
 */
export async function runAutoMergeDuplicates(
  db: PrismaClient,
  opts: { actorId: string; actorUserId: string | null },
): Promise<AutoMergeResult> {
  const contacts = await db.contact.findMany({
    where: {
      deletedAt: null,
      OR: [{ email: { not: null } }, { phoneE164: { not: null } }],
    },
    select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
    orderBy: { createdAt: 'asc' }, // oldest-first → oldest is the survivor
    take: SCAN_LIMIT,
  })

  const rows = contacts.map((c) => ({
    id: c.id,
    email: c.email,
    phoneE164: c.phoneE164,
    name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || null,
  }))
  const plans = planAutoMerges(rows)

  let merged = 0
  let skipped = 0
  let clustersMerged = 0
  for (const plan of plans) {
    if (merged >= MAX_MERGES_PER_RUN) break
    let mergedInThisCluster = false
    for (const loserId of plan.loserIds) {
      if (merged >= MAX_MERGES_PER_RUN) break
      try {
        const result = await mergeContacts(db, {
          survivorId: plan.survivorId,
          loserId,
          actorUserId: opts.actorUserId,
        })
        await writeAuditLogEntry(db, {
          actorId: opts.actorId,
          action: 'contact.merged',
          target: { type: 'Contact', id: plan.survivorId },
          after: {
            survivorId: plan.survivorId,
            loserId,
            movedInteractions: result.movedInteractions,
            auto: true,
          },
        })
        merged += 1
        mergedInThisCluster = true
      } catch {
        // Restricted-access conflict or a race (loser already merged/deleted).
        // Never fail the batch — leave this pair for the manual review page.
        skipped += 1
      }
    }
    if (mergedInThisCluster) clustersMerged += 1
  }

  return { scanned: rows.length, clustersMerged, merged, skipped }
}
