// Worker boundary: daily scheduled-erasure sweep (GDPR Article 17).
// CLAUDE.md §17.1, §21.
//
// Every day at 04:30 UTC, find contacts whose 30-day erasure grace window has
// elapsed (`erasureScheduledAt <= now`, not yet erased) and permanently erase
// each via the core crypto-shred + anonymise engine. Each erasure is its own
// Inngest step (granular retries) and is idempotent — a contact erased by a
// concurrent/earlier run is skipped by `eraseContactData`. Concurrency 1.

import { eraseContactData } from '@studymind/core/compliance/erase-contact'
import { inngest } from '@studymind/jobs'
import {
  ERASE_DUE_BATCH_SIZE,
  selectDueErasureContacts,
  type DueErasureDb,
} from '@studymind/jobs/compliance/erase-due-records'

import { db } from '@/lib/db'

const MAX_BATCHES_PER_RUN = 50 // Cap a single run at 50 * batch contacts.

export const eraseDueRecordsDaily = inngest.createFunction(
  {
    id: 'compliance/erase-due-records',
    name: 'Compliance: scheduled contact erasure (GDPR)',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '30 4 * * *' },
  async ({ step, logger }) => {
    let total = 0

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const ids = await step.run(`select-${batch}`, () =>
        selectDueErasureContacts(db as unknown as DueErasureDb, new Date(), ERASE_DUE_BATCH_SIZE),
      )
      if (ids.length === 0) break

      for (const id of ids) {
        await step.run(`erase-${id}`, () =>
          eraseContactData(db, {
            contactId: id,
            actorId: 'system:compliance/erase-due-records',
            reason: 'Scheduled erasure — 30-day grace window elapsed',
          }),
        )
        total += 1
      }
    }

    logger?.info?.({ erased: total }, 'compliance/erase-due-records complete')
    return { erased: total }
  },
)
