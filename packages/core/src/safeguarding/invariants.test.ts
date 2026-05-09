// §41.3 Safeguarding invariants — property-based tests.

import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  checkDecryptHasPurpose,
  checkNoHardDeleteWithActiveFlag,
  checkRestrictedAccessHasDsl,
} from './invariants'

const SEED = 1714867200000

describe('§41.3 Safeguarding invariants — property-based', () => {
  it('checkRestrictedAccessHasDsl: restricted_access without DSL fails', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('none', 'concern_logged', 'restricted_access'),
        fc.option(fc.uuid(), { nil: null }),
        (state, dslUserId) => {
          const r = checkRestrictedAccessHasDsl({ state, dslUserId })
          if (state === 'restricted_access' && !dslUserId) expect(r.ok).toBe(false)
          else expect(r.ok).toBe(true)
        },
      ),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkDecryptHasPurpose: empty/whitespace fails, real string passes', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: null }), (purpose) => {
        const r = checkDecryptHasPurpose(purpose)
        const trimmed = (purpose ?? '').trim()
        expect(r.ok).toBe(trimmed.length > 0)
      }),
      { seed: SEED, numRuns: 200 },
    )
  })

  it('checkNoHardDeleteWithActiveFlag: hard delete with flag fails', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hardDelete, hasActiveFlag) => {
        const r = checkNoHardDeleteWithActiveFlag({ hardDelete, hasActiveFlag })
        expect(r.ok).toBe(!(hardDelete && hasActiveFlag))
      }),
      { seed: SEED, numRuns: 200 },
    )
  })
})
