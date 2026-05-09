import { afterEach, describe, expect, it } from 'vitest'

import {
  assertContactNotRestricted,
  setRestrictedGuardDb,
  type RestrictedGuardDb,
} from './restricted-guard'

afterEach(() => setRestrictedGuardDb(null))

function makeDb(restrictedIds: string[]): RestrictedGuardDb {
  return {
    safeguardingFlag: {
      findFirst: async ({ where }) =>
        restrictedIds.includes(where.contactId) ? { id: 'flag-1' } : null,
    },
  }
}

describe('assertContactNotRestricted', () => {
  it('no-op when contactId is undefined', async () => {
    setRestrictedGuardDb(makeDb(['c-1']))
    await expect(assertContactNotRestricted(undefined)).resolves.toBeUndefined()
  })

  it('no-op when no db is injected', async () => {
    setRestrictedGuardDb(null)
    await expect(assertContactNotRestricted('c-1')).resolves.toBeUndefined()
  })

  it('passes when contact has no restricted flag', async () => {
    setRestrictedGuardDb(makeDb(['c-1']))
    await expect(assertContactNotRestricted('c-2')).resolves.toBeUndefined()
  })

  it('throws CONTACT_RESTRICTED when contact is restricted_access', async () => {
    setRestrictedGuardDb(makeDb(['c-1']))
    await expect(assertContactNotRestricted('c-1')).rejects.toThrow(/restricted/i)
  })
})
