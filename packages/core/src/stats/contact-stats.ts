// Per-contact communication counts surfaced on the Contacts list. CLAUDE.md
// §6.2 (Interactions are the timeline), §27 (list view-models pre-shaped on
// the server). One batched groupBy keyed on (contactId, type) covers a whole
// page, so a 25-row list costs a single extra query.
//
// Money / hours / last-lesson are NOT computed here — they live directly on
// the Contact row, written per-contact by the booking.studymind.co.uk sync
// (CLAUDE.md §15). We deliberately do not roll those up through Family; a
// contact carries its own figures.

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = PrismaClient | Prisma.TransactionClient

export interface ContactCommsCounts {
  callCount: number
  emailCount: number
  textCount: number
}

const ZERO: ContactCommsCounts = { callCount: 0, emailCount: 0, textCount: 0 }

// Email lands on the timeline as one of three types depending on the source
// (manual log, Gmail inbound, Gmail outbound). We count all three together.
const EMAIL_TYPES = ['email', 'email_received', 'email_sent'] as const

export async function loadContactCommsCounts(
  db: Db,
  contactIds: string[],
): Promise<Map<string, ContactCommsCounts>> {
  const out = new Map<string, ContactCommsCounts>()
  if (contactIds.length === 0) return out
  for (const id of contactIds) out.set(id, { ...ZERO })

  const groups = await db.interaction.groupBy({
    by: ['contactId', 'type'],
    where: {
      contactId: { in: contactIds },
      deletedAt: null,
      type: { in: ['call', 'message', ...EMAIL_TYPES] },
    },
    _count: { _all: true },
  })

  for (const row of groups) {
    if (!row.contactId) continue
    const entry = out.get(row.contactId)
    if (!entry) continue
    const n = row._count._all
    if (row.type === 'call') entry.callCount += n
    else if (row.type === 'message') entry.textCount += n
    else entry.emailCount += n // one of the three EMAIL_TYPES
  }

  return out
}
