// Worker boundary: automatically merge confident duplicate contacts, hourly
// (ADR 0047). The safe decision + the audited merge/skip loop live in the
// shared `runAutoMergeDuplicates` service; this boundary just supplies `db` and
// the system actor. Self-healing: any duplicate created between runs (manual
// entry, Trengo/Medi imports, call auto-create) is folded in on the next tick.
// Disable with CONTACTS_AUTO_MERGE=off.

import { writeAuditLogEntry } from '@studymind/audit'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'
import { runAutoMergeDuplicates } from '@/lib/services/auto-merge-duplicates'

const SYSTEM_ACTOR = 'system:contacts/auto-merge-duplicates'

export const autoMergeDuplicatesHourly = inngest.createFunction(
  {
    id: 'contacts/auto-merge-duplicates',
    name: 'Contacts: auto-merge confident duplicates',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    if ((process.env['CONTACTS_AUTO_MERGE'] ?? '').toLowerCase() === 'off') {
      return { disabled: true, merged: 0 }
    }

    // Drain the ENTIRE duplicate backlog in one tick (operator ask 2026-07 —
    // "merge all, fully automated retrospectively"). Each pass merges up to the
    // service cap (1000) and soft-deletes the losers, so the next pass's scan
    // finds the next batch; loop until a pass merges nothing (drained, or only
    // skip-conflicts remain). MAX_PASSES × cap = the hard ceiling per tick; a
    // normal org drains in a single pass, so passes 2+ only run on a big
    // historic backlog.
    const MAX_PASSES = 25
    const totals = { scanned: 0, clustersMerged: 0, merged: 0, skipped: 0 }
    let passes = 0
    for (; passes < MAX_PASSES; passes++) {
      const result = await step.run(`auto-merge-${passes}`, () =>
        runAutoMergeDuplicates(db, { actorId: SYSTEM_ACTOR, actorUserId: null }),
      )
      totals.scanned += result.scanned
      totals.clustersMerged += result.clustersMerged
      totals.merged += result.merged
      totals.skipped += result.skipped
      if (result.merged === 0) break // backlog drained
    }

    if (totals.merged > 0) {
      await step.run('audit-summary', () =>
        writeAuditLogEntry(db, {
          actorId: SYSTEM_ACTOR,
          action: 'contact.merged',
          target: { type: 'System', id: 'contacts/auto-merge-duplicates' },
          after: { ...totals, passes: passes + 1 },
        }),
      )
    }

    logger.info({ ...totals, passes: passes + 1 }, 'contacts auto-merge complete')
    return { ...totals, passes: passes + 1 }
  },
)
