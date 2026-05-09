// Tests for the LAContract creation flow. CLAUDE.md §43.2.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { createLAContractFromTender } from './index'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: { tenderState?: string } = {}) {
  const tenders: FakeRow[] = [
    { id: 'tend_1', state: opts.tenderState ?? 'awarded', isSemhOrEhcpHeavy: false },
  ]
  const contracts: FakeRow[] = []
  const families: FakeRow[] = []
  const contacts: FakeRow[] = []
  const familyMembers: FakeRow[] = []
  const placements: FakeRow[] = []
  const policies: FakeRow[] = []
  const interactions: FakeRow[] = []
  const auditEntries: FakeRow[] = []

  const create =
    (target: FakeRow[]) =>
    ({ data }: { data: Record<string, unknown> }) => {
      target.push({ ...data } as FakeRow)
      return Promise.resolve({ id: data['id'] })
    }

  const db = {
    tender: {
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const t = tenders.find((row) => row.id === where.id)
        if (!t) return Promise.reject(new Error('not found'))
        return Promise.resolve(t)
      },
    },
    lAContract: { create: create(contracts) },
    family: { create: create(families) },
    contact: { create: create(contacts) },
    familyMember: { create: create(familyMembers) },
    aPPlacement: { create: create(placements) },
    retentionPolicy: { create: create(policies) },
    interaction: { create: create(interactions) },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: create(auditEntries),
    },
  }

  return {
    db: db as never,
    contracts,
    families,
    contacts,
    familyMembers,
    placements,
    policies,
    interactions,
    auditEntries,
  }
}

const ACTOR = { actorId: 'user_1', requestId: 'req_1' }

describe('createLAContractFromTender', () => {
  it('creates a contract, learner family, AP placement, retention policy', async () => {
    const fake = makeFakeDb()
    const result = await createLAContractFromTender(
      fake.db,
      {
        tenderId: 'tend_1',
        reference: 'CAM-2026-001',
        laName: 'LB Camden',
        contractValueMinor: 50_000_00,
        startDate: new Date('2026-09-01'),
        accountLeadId: 'user_1',
        retentionOverride: { retentionDays: 25 * 365, notes: 'Camden SEND policy' },
        learnerPlacements: [
          {
            firstName: 'L',
            lastName: 'M',
            dateOfBirth: new Date('2012-03-04'),
            apPlacement: {
              apStartDate: new Date('2026-09-01'),
              apReviewDate: new Date('2026-12-01'),
              statutoryReason: 'Section 19',
            },
          },
        ],
      },
      ACTOR,
    )

    expect(result.familyIds).toHaveLength(1)
    expect(result.retentionPolicyId).not.toBeNull()
    expect(fake.contracts[0]?.['billingCadence']).toBe('monthly')
    expect(fake.families[0]?.['billingParty']).toBe('local_authority')
    expect(fake.placements).toHaveLength(1)
    expect(fake.policies[0]?.['retentionDays']).toBe(25 * 365)
    expect(fake.interactions[0]?.['type']).toBe('lacontract_created')
    expect(fake.auditEntries[0]?.['action']).toBe('lacontract.created')
  })

  it('refuses to create a contract from a non-awarded tender', async () => {
    const fake = makeFakeDb({ tenderState: 'submitted' })
    await expect(
      createLAContractFromTender(
        fake.db,
        {
          tenderId: 'tend_1',
          reference: 'r',
          laName: 'la',
          contractValueMinor: 0,
          startDate: new Date(),
          accountLeadId: 'u',
          learnerPlacements: [],
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})
