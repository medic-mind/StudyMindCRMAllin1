// Pure selector for the scheduled-erasure cron (GDPR Article 17, CLAUDE.md §21).
// A contact whose `erasureScheduledAt` grace window has elapsed and which has
// not yet been erased is due. The worker boundary loops this and calls the
// core `eraseContactData` crypto-shred for each. Kept pure so it is testable
// without a DB and without the erasure engine.

export interface DueErasureDb {
  contact: {
    findMany: (args: {
      where: { erasureScheduledAt: { lte: Date }; erasedAt: null }
      select: { id: true }
      orderBy: { erasureScheduledAt: 'asc' }
      take: number
    }) => Promise<Array<{ id: string }>>
  }
}

export const ERASE_DUE_BATCH_SIZE = 100

/** Contact ids whose erasure grace window has elapsed, oldest first. */
export async function selectDueErasureContacts(
  db: DueErasureDb,
  now: Date,
  limit: number = ERASE_DUE_BATCH_SIZE,
): Promise<string[]> {
  const rows = await db.contact.findMany({
    where: { erasureScheduledAt: { lte: now }, erasedAt: null },
    select: { id: true },
    orderBy: { erasureScheduledAt: 'asc' },
    take: limit,
  })
  return rows.map((r) => r.id)
}
