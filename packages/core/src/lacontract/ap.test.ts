import { describe, expect, it } from 'vitest'

import { apReviewOverdue, completeApReview } from './ap'

describe('apReviewOverdue', () => {
  const now = new Date('2026-05-09T00:00:00Z')

  it('returns false for null placement', () => {
    expect(apReviewOverdue(null, now)).toBe(false)
  })

  it('returns false when review is completed', () => {
    expect(
      apReviewOverdue(
        { apReviewDate: new Date('2026-04-01'), reviewStatus: 'completed' },
        now,
      ),
    ).toBe(false)
  })

  it('returns true when review date is in the past and status is pending', () => {
    expect(
      apReviewOverdue(
        { apReviewDate: new Date('2026-04-01'), reviewStatus: 'pending' },
        now,
      ),
    ).toBe(true)
  })

  it('returns false when review date is in the future', () => {
    expect(
      apReviewOverdue(
        { apReviewDate: new Date('2026-06-01'), reviewStatus: 'pending' },
        now,
      ),
    ).toBe(false)
  })
})

describe('completeApReview', () => {
  function makeFakeDb() {
    const placements = [
      {
        id: 'ap_1',
        familyId: 'f1',
        apReviewDate: new Date('2026-04-01'),
        reviewStatus: 'pending',
      },
    ]
    const families = [{ id: 'f1', apPlacement: { reviewStatus: 'pending' } }]
    const interactions: Record<string, unknown>[] = []
    const audit: Record<string, unknown>[] = []
    const db = {
      aPPlacement: {
        findUniqueOrThrow: ({ where }: { where: { familyId: string } }) =>
          Promise.resolve(placements.find((p) => p.familyId === where.familyId)!),
        update: ({
          where,
          data,
        }: {
          where: { familyId: string }
          data: Record<string, unknown>
        }) => {
          const p = placements.find((row) => row.familyId === where.familyId)!
          Object.assign(p, data)
          return Promise.resolve(p)
        },
      },
      family: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(families.find((f) => f.id === where.id) ?? null),
        update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const f = families.find((row) => row.id === where.id)!
          Object.assign(f, data)
          return Promise.resolve(f)
        },
      },
      interaction: {
        create: ({ data }: { data: Record<string, unknown> }) => {
          interactions.push(data)
          return Promise.resolve({ id: data['id'] })
        },
      },
      auditLogEntry: {
        findFirst: () => Promise.resolve(null),
        create: ({ data }: { data: Record<string, unknown> }) => {
          audit.push(data)
          return Promise.resolve({ id: data['id'] })
        },
      },
    }
    return { db: db as never, placements, families, interactions, audit }
  }

  it('flips reviewStatus to completed and writes interaction + audit', async () => {
    const fake = makeFakeDb()
    await completeApReview(
      fake.db,
      { familyId: 'f1', nextReviewDate: new Date('2026-08-01') },
      { actorId: 'u', requestId: 'r' },
    )
    expect(fake.placements[0]?.reviewStatus).toBe('completed')
    expect(fake.placements[0]?.apReviewDate).toEqual(new Date('2026-08-01'))
    expect(fake.audit[0]?.['action']).toBe('ap_placement.review_completed')
  })
})
