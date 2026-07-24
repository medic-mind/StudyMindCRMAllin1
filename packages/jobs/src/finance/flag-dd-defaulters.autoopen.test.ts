// Auto-population + identification of the recovery worklist (ADR 0045
// amendment). Proves that every detected post-cutoff issue becomes a recovery
// case with SAFE defaults (auto-send OFF, no link — §3 never auto-send), that it
// is idempotent (find-or-create), that a contact already being worked is not
// duplicated, and — the fix for the "Unknown · no email · not in CRM" bug — that
// a case is identified from the GoCardless customer, auto-onboarding a CRM
// contact when they were never in the CRM, and floor-filling the GoCardless
// name/email even when no contact can be created.
//
// The core list + onboard functions are stubbed so we exercise the create/skip/
// identify logic in isolation; ddIssueMeetsCutoff / DEFAULT_DD_ISSUE_CUTOFF stay
// real.

import { describe, expect, it, vi } from 'vitest'

const {
  listPlanShortfalls,
  listActivePlanArrears,
  listDefaulters,
  resolveOrCreateContactForGcCustomer,
} = vi.hoisted(() => ({
  listPlanShortfalls: vi.fn(),
  listActivePlanArrears: vi.fn(),
  listDefaulters: vi.fn(),
  resolveOrCreateContactForGcCustomer: vi.fn(),
}))

vi.mock('@studymind/core/finance', async (importActual) => {
  const actual = await importActual<typeof import('@studymind/core/finance')>()
  return {
    ...actual,
    listPlanShortfalls,
    listActivePlanArrears,
    listDefaulters,
    resolveOrCreateContactForGcCustomer,
  }
})

import { autoOpenRecoveryCases, backfillRecoveryCaseContacts } from './flag-dd-defaulters'

const NOW = new Date('2026-08-01T12:00:00Z')
const AFTER_CUTOFF = new Date('2026-07-15T00:00:00Z')
const BEFORE_CUTOFF = new Date('2026-06-01T00:00:00Z')

interface CreatedCase {
  gcSubscriptionId: string | null
  contactId: string | null
  personName: string | null
  sendEmails: boolean
  sendTexts: boolean
  setupLinkUrl: string | null
  nextAutoMessageAt: Date | null
  chaseEmail: string | null
  chasePhoneE164: string | null
  openingShortfallMinor: number
}

function makeDb(
  opts: {
    existingBySub?: Set<string>
    existingByContact?: Set<string>
  } = {},
) {
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
        familyMembers: [],
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
    gcSubscription: {
      findFirst: async () => null,
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
    // Contact details are seeded from the linked contact (fill-only).
    expect(c.chaseEmail).toBe('c1@example.com')
  })

  it('identifies an unlinked plan by onboarding a CRM contact from GoCardless', async () => {
    // The plan has a GoCardless customer but no CRM contact — the "Unknown" case.
    resolveOrCreateContactForGcCustomer.mockResolvedValue({
      contactId: 'new-contact',
      created: true,
      linked: true,
      displayName: 'Lamar Fallatah',
      email: 'lamar@gc.example',
      phone: '+447700900321',
    })
    listPlanShortfalls.mockResolvedValue([
      {
        gcSubscriptionId: 'SUB2',
        gcCustomerId: 'CU9',
        contactId: null,
        familyId: null,
        shortfallMinor: 36066,
        issueDate: AFTER_CUTOFF,
      },
    ])
    listActivePlanArrears.mockResolvedValue([])
    listDefaulters.mockResolvedValue([])

    const { db, created } = makeDb()
    const res = await autoOpenRecoveryCases(db, NOW)

    expect(res.plansOpened).toBe(1)
    const c = created[0]!
    // A real CRM contact now backs the case — no longer "Unknown / not in CRM".
    expect(c.contactId).toBe('new-contact')
    expect(c.personName).toBeNull()
    // chaseEmail comes from the (freshly created) CRM contact.
    expect(c.chaseEmail).toBe('new-contact@example.com')
    expect(resolveOrCreateContactForGcCustomer).toHaveBeenCalledWith(
      db,
      { gcCustomerId: 'CU9' },
      { actorId: null },
    )
  })

  it('is idempotent — a plan that already has a case is skipped', async () => {
    listPlanShortfalls.mockResolvedValue([
      {
        gcSubscriptionId: 'SUB1',
        gcCustomerId: null,
        contactId: null,
        familyId: null,
        shortfallMinor: 100,
        issueDate: AFTER_CUTOFF,
      },
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
      {
        gcSubscriptionId: 'OLD',
        gcCustomerId: null,
        contactId: null,
        familyId: null,
        shortfallMinor: 100,
        issueDate: BEFORE_CUTOFF,
      },
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

interface CaseRow {
  id: string
  gcSubscriptionId: string | null
  gcCustomerId: string | null
  contactId: string | null
  familyId: string | null
  personName: string | null
  chaseEmail: string | null
  chasePhoneE164: string | null
}

function makeBackfillDb(opts: {
  cases: CaseRow[]
  contact?: { email: string | null; phoneE164: string | null } | null
}) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const db = {
    directDebitCase: {
      findMany: async () => opts.cases,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push({ id: where.id, data })
        return data
      },
    },
    gcSubscription: { findFirst: async () => null },
    family: { findFirst: async () => null },
    contact: {
      findFirst: async () =>
        opts.contact ? { ...opts.contact, familyMembers: [] } : null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return { db, updates }
}

describe('backfillRecoveryCaseContacts', () => {
  it('identifies a case via its GoCardless customer and fills contact + chase details', async () => {
    resolveOrCreateContactForGcCustomer.mockResolvedValue({
      contactId: 'c1',
      created: false,
      linked: true,
      displayName: 'Ilona Pisarek',
      email: 'ilona@gc.example',
      phone: '+447700900123',
    })
    const { db, updates } = makeBackfillDb({
      cases: [
        {
          id: 'case1',
          gcSubscriptionId: null,
          gcCustomerId: 'CU1',
          contactId: null,
          familyId: null,
          personName: null,
          chaseEmail: null,
          chasePhoneE164: null,
        },
      ],
      contact: { email: 'c1@example.com', phoneE164: '+447700900123' },
    })
    const res = await backfillRecoveryCaseContacts(db)
    expect(res.updated).toBe(1)
    expect(updates[0]!.data['contactId']).toBe('c1')
    // chase details come from the resolved CRM contact.
    expect(updates[0]!.data['chaseEmail']).toBe('c1@example.com')
    expect(updates[0]!.data['chasePhoneE164']).toBe('+447700900123')
    // personName is only a fallback — a linked contact wins, so it is not set.
    expect(updates[0]!.data['personName']).toBeUndefined()
  })

  it('floor-fills the GoCardless name + email even when no CRM contact can be created', async () => {
    // The onboard could not create a contact (e.g. no identifier) but still
    // surfaces the GoCardless display fields — the case must not stay "Unknown".
    resolveOrCreateContactForGcCustomer.mockResolvedValue({
      contactId: null,
      created: false,
      linked: false,
      displayName: 'Jane Doe',
      email: 'jane@gc.example',
      phone: null,
    })
    const { db, updates } = makeBackfillDb({
      cases: [
        {
          id: 'case2',
          gcSubscriptionId: null,
          gcCustomerId: 'CU2',
          contactId: null,
          familyId: null,
          personName: null,
          chaseEmail: null,
          chasePhoneE164: null,
        },
      ],
      contact: null,
    })
    const res = await backfillRecoveryCaseContacts(db)
    expect(res.updated).toBe(1)
    expect(updates[0]!.data['contactId']).toBeUndefined()
    expect(updates[0]!.data['chaseEmail']).toBe('jane@gc.example')
    expect(updates[0]!.data['personName']).toBe('Jane Doe')
  })

  it('never overwrites a staff-set chase email (fill-blank only)', async () => {
    resolveOrCreateContactForGcCustomer.mockResolvedValue({
      contactId: 'c3',
      created: false,
      linked: true,
      displayName: 'Yasmin Ali',
      email: 'yasmin@gc.example',
      phone: '+447700900999',
    })
    const { db, updates } = makeBackfillDb({
      cases: [
        {
          id: 'case3',
          gcSubscriptionId: null,
          gcCustomerId: 'CU3',
          contactId: null,
          familyId: null,
          personName: null,
          chaseEmail: 'manual@x.com',
          chasePhoneE164: null,
        },
      ],
      contact: { email: 'c3@example.com', phoneE164: '+447700900999' },
    })
    const res = await backfillRecoveryCaseContacts(db)
    expect(res.updated).toBe(1)
    expect(updates[0]!.data['contactId']).toBe('c3')
    // chaseEmail was already set — must not be clobbered.
    expect(updates[0]!.data['chaseEmail']).toBeUndefined()
    expect(updates[0]!.data['chasePhoneE164']).toBe('+447700900999')
  })
})
