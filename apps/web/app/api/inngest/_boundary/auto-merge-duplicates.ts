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

    const result = await step.run('auto-merge', () =>
      runAutoMergeDuplicates(db, { actorId: SYSTEM_ACTOR, actorUserId: null }),
    )

    if (result.merged > 0) {
      await step.run('audit-summary', () =>
        writeAuditLogEntry(db, {
          actorId: SYSTEM_ACTOR,
          action: 'contact.merged',
          target: { type: 'System', id: 'contacts/auto-merge-duplicates' },
          after: result,
        }),
      )
    }

    logger.info(result, 'contacts auto-merge complete')
    return result
  },
)
