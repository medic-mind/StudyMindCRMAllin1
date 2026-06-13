// Resolve the B2B account a matched email Contact belongs to, so synced /
// backfilled emails surface on the School/Partnership Activity timeline the same
// way notes and tasks do (they stamp `Interaction.businessAccountId`). A Contact
// can belong to more than one account (BusinessAccountContact is M:N); we pick a
// single deterministic "primary" so one email lands on one account timeline
// rather than fanning out. Pure map-builder is unit-tested; the DB wrapper is a
// thin batched query reused by both the live sync and the backfill.

import { db } from '@studymind/db'

export interface ContactAccountLink {
  contactId: string
  accountId: string
}

/**
 * Build a `contactId -> primary accountId` map from junction rows. Deterministic:
 * the first row seen per contact wins, so callers should pass rows in a stable
 * order (e.g. ordered by accountId).
 */
export function firstAccountByContact(
  rows: ReadonlyArray<ContactAccountLink>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const r of rows) {
    if (!map.has(r.contactId)) map.set(r.contactId, r.accountId)
  }
  return map
}

/**
 * Batched lookup: for each contact id, the B2B account it primarily belongs to
 * (or absent from the map when it belongs to none). One query for the whole
 * message's matched contacts.
 */
export async function primaryAccountByContact(
  contactIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  if (contactIds.length === 0) return new Map()
  const rows = await db.businessAccountContact.findMany({
    where: { contactId: { in: [...contactIds] } },
    select: { contactId: true, accountId: true },
    orderBy: { accountId: 'asc' },
  })
  return firstAccountByContact(rows)
}
