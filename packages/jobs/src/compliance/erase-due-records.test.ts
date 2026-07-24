import { describe, expect, it } from 'vitest'

import { selectDueErasureContacts } from './erase-due-records'

describe('selectDueErasureContacts', () => {
  it('queries due, not-yet-erased contacts oldest-first and returns their ids', async () => {
    let captured: unknown
    const db = {
      contact: {
        findMany: (args: unknown) => {
          captured = args
          return Promise.resolve([{ id: 'c1' }, { id: 'c2' }])
        },
      },
    }
    const now = new Date('2026-07-24T00:00:00.000Z')
    const ids = await selectDueErasureContacts(db as never, now, 50)
    expect(ids).toEqual(['c1', 'c2'])
    expect(captured).toEqual({
      where: { erasureScheduledAt: { lte: now }, erasedAt: null },
      select: { id: true },
      orderBy: { erasureScheduledAt: 'asc' },
      take: 50,
    })
  })
})
