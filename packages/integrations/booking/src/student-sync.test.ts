// Pure sync-logic tests (ADR 0029): the incremental walk + the contact-match
// decision + booking-status derivation. The DB upserts are covered by
// integration tests only (CLAUDE.md §23.2).

import { describe, expect, it } from 'vitest'

import {
  decideContactMatch,
  deriveBookingStatus,
  drainIncremental,
  type SyncState,
} from './student-sync'
import type { BookingStudent, Page } from './types'

interface Item {
  externalId: string
  updatedAt: Date
}

function page(data: Item[], nextCursor: string | null, hasMore: boolean): Page<Item> {
  return { data, nextCursor, hasMore }
}

describe('decideContactMatch', () => {
  it('uses the existing booking link first', () => {
    expect(decideContactMatch({ byBookingId: 'c1', byEmailOrPhone: ['c2', 'c3'] })).toEqual({
      kind: 'use',
      contactId: 'c1',
    })
  })

  it('adopts a single unambiguous email/phone match', () => {
    expect(decideContactMatch({ byBookingId: null, byEmailOrPhone: ['c2'] })).toEqual({
      kind: 'link',
      contactId: 'c2',
    })
  })

  it('creates when there is no match or an ambiguous one (never merges)', () => {
    expect(decideContactMatch({ byBookingId: null, byEmailOrPhone: [] })).toEqual({
      kind: 'create',
    })
    expect(decideContactMatch({ byBookingId: null, byEmailOrPhone: ['c2', 'c3'] })).toEqual({
      kind: 'create',
    })
  })
})

describe('deriveBookingStatus', () => {
  const base = {
    balance: {
      hoursAdded: 0,
      hoursUsed: 0,
      hoursDeducted: 0,
      hoursRemaining: 0,
      premiumHoursAdded: 0,
      premiumHoursUsed: 0,
      premiumHoursDeducted: 0,
      premiumHoursRemaining: 0,
      nextExpiryAt: null,
    },
    credits: { onlineMmi: 0, inPersonMmi: 0, liveDay: 0, inPersonLiveDay: 0 },
  } as unknown as BookingStudent

  it('registered_with_hours when any hours present', () => {
    expect(deriveBookingStatus({ ...base, balance: { ...base.balance, hoursAdded: 5 } })).toBe(
      'registered_with_hours',
    )
  })

  it('registered_with_hours when only credits present', () => {
    expect(deriveBookingStatus({ ...base, credits: { ...base.credits, onlineMmi: 1 } })).toBe(
      'registered_with_hours',
    )
  })

  it('registered_no_hours when nothing present', () => {
    expect(deriveBookingStatus(base)).toBe('registered_no_hours')
  })
})

describe('drainIncremental', () => {
  const start: SyncState = { updatedSince: new Date('2026-01-01T00:00:00Z'), cursor: null }

  it('drains a single page and advances the high-water mark', async () => {
    const seen: string[] = []
    const res = await drainIncremental<Item>({
      state: start,
      maxPages: 25,
      fetchPage: async () =>
        page(
          [
            { externalId: 'a', updatedAt: new Date('2026-02-01T00:00:00Z') },
            { externalId: 'b', updatedAt: new Date('2026-03-01T00:00:00Z') },
          ],
          null,
          false,
        ),
      processItem: async (i) => {
        seen.push(i.externalId)
      },
    })
    expect(seen).toEqual(['a', 'b'])
    expect(res.processed).toBe(2)
    expect(res.drained).toBe(true)
    expect(res.newState.cursor).toBeNull()
    expect(res.newState.updatedSince?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('isolates a poison row — skips it, still processes the rest, advances the cursor', async () => {
    const seen: string[] = []
    const res = await drainIncremental<Item>({
      state: start,
      maxPages: 25,
      fetchPage: async () =>
        page(
          [
            { externalId: 'ok1', updatedAt: new Date('2026-02-01T00:00:00Z') },
            { externalId: 'poison', updatedAt: new Date('2026-02-15T00:00:00Z') },
            { externalId: 'ok2', updatedAt: new Date('2026-03-01T00:00:00Z') },
          ],
          null,
          false,
        ),
      processItem: async (i) => {
        if (i.externalId === 'poison') throw new Error('boom')
        seen.push(i.externalId)
      },
    })
    expect(seen).toEqual(['ok1', 'ok2'])
    expect(res.processed).toBe(2)
    expect(res.skipped).toBe(1)
    expect(res.drained).toBe(true)
    // The high-water mark still advanced — the poison row did not freeze it.
    expect(res.newState.updatedSince?.toISOString()).toBe('2026-03-01T00:00:00.000Z')
  })

  it('aborts (throws) when EVERY row on a page fails — systemic, must retry not skip', async () => {
    await expect(
      drainIncremental<Item>({
        state: start,
        maxPages: 25,
        fetchPage: async () =>
          page([{ externalId: 'x', updatedAt: new Date('2026-02-01T00:00:00Z') }], null, false),
        processItem: async () => {
          throw new Error('db down')
        },
      }),
    ).rejects.toThrow(/all 1 rows/)
  })

  it('walks multiple pages via the cursor within one run', async () => {
    const pages: Record<string, Page<Item>> = {
      START: page([{ externalId: 'a', updatedAt: new Date('2026-02-01T00:00:00Z') }], 'C1', true),
      C1: page([{ externalId: 'b', updatedAt: new Date('2026-04-01T00:00:00Z') }], null, false),
    }
    const res = await drainIncremental<Item>({
      state: start,
      maxPages: 25,
      fetchPage: async (q) => pages[q.cursor ?? 'START']!,
      processItem: async () => {},
    })
    expect(res.processed).toBe(2)
    expect(res.drained).toBe(true)
    expect(res.newState.updatedSince?.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it('stops at maxPages mid-walk and persists the cursor without advancing updatedSince', async () => {
    const res = await drainIncremental<Item>({
      state: start,
      maxPages: 1,
      fetchPage: async () =>
        page([{ externalId: 'a', updatedAt: new Date('2026-02-01T00:00:00Z') }], 'NEXT', true),
      processItem: async () => {},
    })
    expect(res.processed).toBe(1)
    expect(res.drained).toBe(false)
    expect(res.newState.cursor).toBe('NEXT')
    expect(res.newState.updatedSince?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('handles an empty drained page (nothing changed)', async () => {
    const res = await drainIncremental<Item>({
      state: start,
      maxPages: 25,
      fetchPage: async () => page([], null, false),
      processItem: async () => {},
    })
    expect(res.processed).toBe(0)
    expect(res.drained).toBe(true)
    expect(res.newState.updatedSince?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })
})
