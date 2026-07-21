// Auto-population of the recovery worklist (ADR 0045 amendment). Proves that
// every detected post-cutoff issue becomes a recovery case with SAFE defaults
// (auto-send OFF, no link — §3 never auto-send), that it is idempotent
// (find-or-create), and that a contact already being worked is not duplicated.
//
// The core list functions are stubbed so we exercise the create/skip logic in
// isolation; ddIssueMeetsCutoff / DEFAULT_DD_ISSUE_CUTOFF stay real.

import { describe, expect, it, vi } from 'vitest'

const { listPlanShortfalls, listActivePlanArrears, listDefaulters } = vi.hoisted(() => ({
  listPlanShortfalls: vi.fn(),
  listActivePlanArrears: vi.fn(),
  listDefaulters: vi.fn(),
}))

vi.mock('@studymind/core/finance', async (importActual) => {
  const actual = await importActual<typeof import('@studymind/core/finance')>()
  return { ...actual, listPlanShortfalls, listActivePlanArrears, listDefaulters }
})

import { autoOpenRecoveryCases } from './flag-dd-defaulters'

const NOW = new Date('2026-08-01T12:00:00Z')
const AFTER_CUTOFF = new Date('2026-07-15T00:00:00Z')
const BEFORE_CUTOFF = new Date('2026-06-01T00:00:00Z')

interface CreatedCase {
  gcSubscriptionId: string | null
  contactId: string | null
  sendEmails: boolean
  sendTexts: boolean
  setupLinkUrl: string | null
  nextAutoMessageAt: Date | null
  chaseEmail: string | null
  openingShortfallMinor: number
}

function makeDb(opts: {
  existingBySub?: Set<string>
  existingByContact?: Set<string>
} = {}) {
  const created: CreatedCase[] = []
  const existingBySub = opts.existingBySub ?? new Set<string>()
  const existingByContact = opts.existingByContact ?? new Set<string>()
  const db = {
    directDebitCase: {
      findUnique: async ({ where }: { where: { gcSubscriptionId: string } }) =>
        existingBySub.has(where.gcSubscriptionId) ? { id: 'existing' } : null,
      findFirst: async ({ where }: { where: { contactId: string } }) =>
        existingByContact.has(where.contactId) ? { id: 'existing' } : null,
      create: async ({ data }: { data: CreatedCase }) => {
        created.push(data)
        return data
      },
    },
    contact: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        email: `${where.id}@example.com`,
        phoneE164: '+447700900000',
      }),
    },
    family: {
      findFirst: async ({ where }: { where: { id: string } }) => ({
        billingContactId: `bc-${where.id}`,
      }),
    },
    gcCustomer: {
      findFirst: async () => ({ gcCustomerId: 'CU1' }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, created }
}

describe('autoOpenRecoveryCases', () => {
  it('creates a recovery case for a new plan shortfall with SAFE defaults (§3 no auto-send)', async () => {
    listPlanShortfalls.mockResolvedValue([
      {
        gcSubscriptionId: 'SUB1',
        gcCustomerId: 'CU1',
        contactId: 'c1',
        familyId: 'f1',
        shortfallMinor: 12345,
        issueDate: AFTER_CUTOFF,
      },
    ])
    listActivePlanArrears.mockResolvedValue([])
    listDefaulters.mockResolvedValue([])

    const { db, created } = makeDb()
    const res = await autoOpenRecoveryCases(db, NOW)

    expect(res.plansOpened).toBe(1)
    expect(created).toHaveLength(1)
    const c = created[0]!
    expect(c.gcSubscriptionId).toBe('SUB1')
    expect(c.openingShortfallMinor).toBe(12345)
    // Critical: nothing can auto-send until a human arms it.
    expect(c.sendEmails).toBe(false)
    expect(c.sendTexts).toBe(false)
    expect(c.setupLinkUrl).toBeNull()
    expect(c.nextAutoMessageAt).toBeNull()
    // Contact details are seeded (fill-only).
    expect(c.chaseEmail).toBe('c1@example.com')
  })

  it('is idempotent — a plan that already has a case is skipped', async () => {
    listPlanShortfalls.mockResolvedValue([
      { gcSubscriptionId: 'SUB1', gcCustomerId: null, contactId: null, familyId: null, shortfallMinor: 100, issueDate: AFTER_CUTOFF },
    ])
    listActivePlanArrears.mockResolvedValue([])
    listDefaulters.mockResolvedValue([])

    const { db, created } = makeDb({ existingBySub: new Set(['SUB1']) })
    const res = await autoOpenRecoveryCases(db, NOW)
    expect(res.plansOpened).toBe(0)
    expect(created).toHaveLength(0)
  })

  it('skips pre-cutoff issues (historic imports must not flood the list)', async () => {
    listPlanShortfalls.mockResolvedValue([
      { gcSubscriptionId: 'OLD', gcCustomerId: null, contactId: null, familyId: null, shortfallMinor: 100, issueDate: BEFORE_CUTOFF },
    ])
    listActivePlanArrears.mockResolvedValue([])
    listDefaulters.mockResolvedValue([])

    const { db, created } = makeDb()
    const res = await autoOpenRecoveryCases(db, NOW)
    expect(res.plansOpened).toBe(0)
    expect(created).toHaveLength(0)
  })

  it('opens a defaulter case keyed on the billing contact, and skips one already being worked', async () => {
    listPlanShortfalls.mockResolvedValue([])
    listActivePlanArrears.mockResolvedValue([])
    listDefaulters.mockResolvedValue([
      { familyId: 'fam1', outstandingMinor: 5000, issueDate: AFTER_CUTOFF },
      { familyId: 'fam2', outstandingMinor: 6000, issueDate: AFTER_CUTOFF },
    ])

    // fam1's billing contact (bc-fam1) already has an open case.
    const { db, created } = makeDb({ existingByContact: new Set(['bc-fam1']) })
    const res = await autoOpenRecoveryCases(db, NOW)
    expect(res.defaultersOpened).toBe(1)
    expect(created).toHaveLength(1)
    expect(created[0]!.contactId).toBe('bc-fam2')
    expect(created[0]!.sendEmails).toBe(false)
    expect(created[0]!.setupLinkUrl).toBeNull()
  })
})
