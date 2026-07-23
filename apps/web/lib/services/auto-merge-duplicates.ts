// Automatic duplicate-contact merging (ADR 0047 — operator-authorised, an
// explicit exception to the §3 "humans confirm every merge" rule).
//
// FULLY automatic (operator decision, 2026-07): EVERY duplicate cluster — any
// contacts sharing an email OR a phone — is merged into its oldest member with
// NO human approval step, so there is no manual review queue. The decision is
// the pure `planAutoMerges({ includeAmbiguous: true })`; this service does the
// I/O: load candidate contacts, run each plan through the audited
// `mergeContacts`, and skip (never fail) on a restricted-access conflict. The
// only human control is the `CONTACTS_AUTO_MERGE=off` kill-switch (the "final
// final" backstop) — nothing is parked for per-merge approval.
//
// Note (§41.1): a phone-only match with different names (a possible shared
// family landline) is now merged too. If that produces bad merges, set the
// service back to confident-only by dropping `includeAmbiguous`.
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
  // Full automation: merge every duplicate cluster, no manual review queue.
  const plans = planAutoMerges(rows, { includeAmbiguous: true })

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
