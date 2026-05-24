// Restricted-contact guard.
//
// In the safeguarding workflow this function blocked AI calls against any
// Contact with an active `restricted_access` flag. The safeguarding
// workflow was removed in ADR 0013, so the guard is now a no-op. We keep
// the function (and the optional db injection seam) so that AI client call
// sites do not churn and so a future reinstatement of the workflow has an
// obvious place to plug back in.

export interface RestrictedGuardDb {
  // Intentionally empty: no consumers in v1. Retained for API stability.
  [k: string]: unknown
}

export function setRestrictedGuardDb(_db: RestrictedGuardDb | null): void {
  // no-op
}

export async function assertContactNotRestricted(
  _contactId: string | null | undefined,
): Promise<void> {
  return
}
