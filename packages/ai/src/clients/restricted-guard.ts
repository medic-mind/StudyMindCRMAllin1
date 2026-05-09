// Restricted-contact guard for AI clients. CLAUDE.md §42.3.
//
// Any AI call that mentions a restricted contact must abort BEFORE the
// prompt is sent — restricted contacts are removed from prompt inputs.
// Callers pass a `contactId` and a `db` resolver. The default resolver is
// no-op (no contactId → no check). Tests inject a fake db.

import { BusinessError } from '@studymind/core'

export interface RestrictedGuardDb {
  safeguardingFlag: {
    findFirst: (args: {
      where: { contactId: string; deletedAt: null; state: 'restricted_access' }
      select: { id: true }
    }) => Promise<{ id: string } | null>
  }
}

let cachedDb: RestrictedGuardDb | null = null

/**
 * Inject the db client used by the guard. The web app calls this once at
 * boot. Tests use it directly. Without injection the guard is a no-op
 * (which is safe: callers that pass `contactId` opt into the check).
 */
export function setRestrictedGuardDb(db: RestrictedGuardDb | null): void {
  cachedDb = db
}

export async function assertContactNotRestricted(
  contactId: string | undefined,
): Promise<void> {
  if (!contactId) return
  if (!cachedDb) return
  const flag = await cachedDb.safeguardingFlag.findFirst({
    where: { contactId, deletedAt: null, state: 'restricted_access' },
    select: { id: true },
  })
  if (flag) {
    throw new BusinessError(
      'CONTACT_RESTRICTED',
      'Contact is restricted_access; AI prompts may not reference this contact.',
      { contactId },
    )
  }
}
