// Tests for the tender draft signoff flow. CLAUDE.md §43.1, §42.

import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import { requestTenderDraft } from './draft'
import { signoffTenderDraft } from './signoff'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: { isSemhOrEhcpHeavy: boolean; tenderState?: string } = { isSemhOrEhcpHeavy: false }) {
  const tenders: FakeRow[] = [
    {
      id: 'tend_1',
      laName: 'LB Camden',
      commissioner: 'Inclusion',
      isSemhOrEhcpHeavy: opts.isSemhOrEhcpHeavy,
      state: opts.tenderState ?? 'drafting',
    },
  ]
  const drafts: FakeRow[] = []
  const interactions: FakeRow[] = []
  const auditEntries: FakeRow[] = []

  const db = {
    tender: {
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const t = tenders.find((row) => row.id === where.id)
        if (!t) return Promise.reject(new Error('not found'))
        return Promise.resolve(t)
      },
    },
    tenderDraftRequest: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        drafts.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const d = drafts.find((row) => row.id === where.id)
        if (!d) return Promise.reject(new Error('not found'))
        return Promise.resolve({
          id: d.id,
          tenderId: d['tenderId'],
          signoffState: d['signoffState'],
          tender: tenders.find((t) => t.id === d['tenderId']),
        })
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = drafts.find((row) => row.id === where.id)!
        Object.assign(d, data)
        return Promise.resolve(d)
      },
    },
    interaction: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        interactions.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditEntries.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
  }

  return { db: db as never, tenders, drafts, interactions, auditEntries }
}

const ACTOR = { actorId: 'user_1', requestId: 'req_1' }

const stubRunner = async () => ({
  text: '## Section\nDraft body',
  promptVersion: 'test-1',
})

describe('requestTenderDraft', () => {
  it('persists a pending draft and writes an audit row', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: true })
    const r = await requestTenderDraft(
      fake.db,
      {
        tenderId: 'tend_1',
        brief: 'AP for KS3',
        sectionsToDraft: ['Provision'],
        requesterId: 'user_2',
      },
      ACTOR,
      stubRunner,
    )
    expect(r.draftText).toContain('Section')
    expect(fake.drafts[0]?.['signoffState']).toBe('pending')
    expect(fake.auditEntries[0]?.['action']).toBe('tender.draft_requested')
  })

  it('refuses to draft when tender is in a terminal state', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: false, tenderState: 'awarded' })
    await expect(
      requestTenderDraft(
        fake.db,
        { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
        ACTOR,
        stubRunner,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('signoffTenderDraft — non-SEMH', () => {
  it('account_lead approve advances directly to approved', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: false })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    const res = await signoffTenderDraft(
      fake.db,
      {
        draftId: r.draftId,
        signerId: 'lead_1',
        role: 'account_lead',
        decision: 'approve',
      },
      ACTOR,
    )
    expect(res.isApproved).toBe(true)
    expect(res.signoffState).toBe('approved')
  })

  it('rejects DSL signoff on non-SEMH drafts', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: false })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    await expect(
      signoffTenderDraft(
        fake.db,
        { draftId: r.draftId, signerId: 'd', role: 'dsl', decision: 'approve' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('signoffTenderDraft — SEMH/EHCP-heavy', () => {
  it('requires both account_lead and dsl signoff for approval', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: true })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    const a = await signoffTenderDraft(
      fake.db,
      { draftId: r.draftId, signerId: 'lead', role: 'account_lead', decision: 'approve' },
      ACTOR,
    )
    expect(a.isApproved).toBe(false)
    expect(a.signoffState).toBe('account_lead_approved')

    const b = await signoffTenderDraft(
      fake.db,
      { draftId: r.draftId, signerId: 'dsl_user', role: 'dsl', decision: 'approve' },
      ACTOR,
    )
    expect(b.isApproved).toBe(true)
    expect(b.signoffState).toBe('approved')
  })

  it('approval is order-independent (DSL first, then account_lead)', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: true })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    await signoffTenderDraft(
      fake.db,
      { draftId: r.draftId, signerId: 'd', role: 'dsl', decision: 'approve' },
      ACTOR,
    )
    const final = await signoffTenderDraft(
      fake.db,
      { draftId: r.draftId, signerId: 'l', role: 'account_lead', decision: 'approve' },
      ACTOR,
    )
    expect(final.isApproved).toBe(true)
  })

  it('reject is terminal and locks the draft', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: true })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    await signoffTenderDraft(
      fake.db,
      { draftId: r.draftId, signerId: 'l', role: 'account_lead', decision: 'reject' },
      ACTOR,
    )
    await expect(
      signoffTenderDraft(
        fake.db,
        { draftId: r.draftId, signerId: 'd', role: 'dsl', decision: 'approve' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('request_changes leaves state and writes interaction', async () => {
    const fake = makeFakeDb({ isSemhOrEhcpHeavy: true })
    const r = await requestTenderDraft(
      fake.db,
      { tenderId: 'tend_1', brief: 'b', requesterId: 'u' },
      ACTOR,
      stubRunner,
    )
    fake.interactions.length = 0
    const res = await signoffTenderDraft(
      fake.db,
      {
        draftId: r.draftId,
        signerId: 'l',
        role: 'account_lead',
        decision: 'request_changes',
        rationale: 'tighten outcomes section',
      },
      ACTOR,
    )
    expect(res.signoffState).toBe('pending')
    expect(fake.interactions[0]?.['type']).toBe('tender_draft_signed_off')
  })
})
