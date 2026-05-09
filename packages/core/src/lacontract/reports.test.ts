import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { generateProgressReportDraft, signoffProgressReport } from './reports'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: { existingState?: string | null } = {}) {
  const reports: FakeRow[] = []
  if (opts.existingState) {
    reports.push({
      id: 'r0',
      contractId: 'c1',
      familyId: 'f1',
      periodStart: new Date('2026-04-01'),
      periodEnd: new Date('2026-04-30'),
      state: opts.existingState,
    })
  }
  const interactions: FakeRow[] = []
  const auditEntries: FakeRow[] = []

  const db = {
    lAContract: {
      findUniqueOrThrow: ({ where }: { where: { id: string } }) =>
        Promise.resolve({ id: where.id, laName: 'LB Camden', reference: 'CAM-2026-001' }),
    },
    lAProgressReport: {
      findUnique: ({ where }: { where: Record<string, unknown> }) => {
        const k = where['contractId_familyId_periodStart_periodEnd'] as
          | { contractId: string; familyId: string; periodStart: Date; periodEnd: Date }
          | undefined
        if (!k) return Promise.resolve(null)
        return Promise.resolve(
          reports.find(
            (r) =>
              r['contractId'] === k.contractId &&
              r['familyId'] === k.familyId &&
              (r['periodStart'] as Date).getTime() === k.periodStart.getTime() &&
              (r['periodEnd'] as Date).getTime() === k.periodEnd.getTime(),
          ) ?? null,
        )
      },
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const r = reports.find((row) => row.id === where.id)
        if (!r) return Promise.reject(new Error('not found'))
        return Promise.resolve(r)
      },
      create: ({ data }: { data: Record<string, unknown> }) => {
        reports.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const r = reports.find((row) => row.id === where.id)!
        Object.assign(r, data)
        return Promise.resolve(r)
      },
    },
    bookingSession: { findMany: () => Promise.resolve([]) },
    interaction: {
      findMany: () => Promise.resolve([]),
      create: ({ data }: { data: Record<string, unknown> }) => {
        interactions.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
    safeguardingFlag: { findMany: () => Promise.resolve([]) },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditEntries.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
  }

  return { db: db as never, reports, interactions, auditEntries }
}

const ACTOR = { actorId: 'user_1', requestId: 'req_1' }

const stubRunner = async () => ({
  text: '## Summary\nDelivered AP placement for the period.',
  promptVersion: 'pr-test-1',
})

describe('generateProgressReportDraft', () => {
  it('creates a draft report with the prompt version', async () => {
    const fake = makeFakeDb()
    const r = await generateProgressReportDraft(
      fake.db,
      {
        contractId: 'c1',
        learnerFamilyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
      },
      ACTOR,
      stubRunner,
    )
    expect(r.draftText).toContain('Summary')
    expect(fake.reports[0]?.['state']).toBe('draft')
    expect(fake.auditEntries[0]?.['action']).toBe('lacontract.progress_report_drafted')
  })

  it('refuses when an existing draft report is in place', async () => {
    const fake = makeFakeDb({ existingState: 'draft' })
    await expect(
      generateProgressReportDraft(
        fake.db,
        {
          contractId: 'c1',
          learnerFamilyId: 'f1',
          periodStart: new Date('2026-04-01'),
          periodEnd: new Date('2026-04-30'),
        },
        ACTOR,
        stubRunner,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('signoffProgressReport', () => {
  it('approves a draft and writes interaction', async () => {
    const fake = makeFakeDb()
    const r = await generateProgressReportDraft(
      fake.db,
      {
        contractId: 'c1',
        learnerFamilyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
      },
      ACTOR,
      stubRunner,
    )
    fake.interactions.length = 0
    const res = await signoffProgressReport(
      fake.db,
      { reportId: r.reportId, signerId: 'lead', decision: 'approve' },
      ACTOR,
    )
    expect(res.state).toBe('signed')
    expect(fake.interactions[0]?.['type']).toBe('lacontract_progress_report_signed')
  })

  it('rejecting transitions to rejected and does not write a signed-interaction', async () => {
    const fake = makeFakeDb()
    const r = await generateProgressReportDraft(
      fake.db,
      {
        contractId: 'c1',
        learnerFamilyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
      },
      ACTOR,
      stubRunner,
    )
    fake.interactions.length = 0
    const res = await signoffProgressReport(
      fake.db,
      { reportId: r.reportId, signerId: 'lead', decision: 'reject' },
      ACTOR,
    )
    expect(res.state).toBe('rejected')
    expect(fake.interactions).toHaveLength(0)
  })
})
