// Pure transition logic for Direct Debit recovery cases (ADR 0038).

import { describe, expect, it } from 'vitest'

import {
  canTransition,
  isClosedStatus,
  recordRecovery,
  setCaseStatus,
  CaseTransitionError,
  type DirectDebitCaseRow,
} from './dd-cases'

/** Minimal in-memory fake for the DirectDebitCase table. */
function makeCaseDb(seed: Partial<DirectDebitCaseRow> & { gcSubscriptionId: string }) {
  const rows: Record<string, unknown>[] = [
    {
      id: 'case_1',
      gcSubscriptionId: seed.gcSubscriptionId,
      gcCustomerId: null,
      contactId: null,
      familyId: null,
      status: seed.status ?? 'new',
      ownerUserId: null,
      openingShortfallMinor: seed.openingShortfallMinor ?? 0,
      recoveredMinor: 0,
      recoveredAt: null,
      recoveryMethod: null,
      recoveryRef: null,
      notes: null,
      updatedAt: new Date('2026-06-14T00:00:00Z'),
    },
  ]
  return {
    _rows: rows,
    directDebitCase: {
      findUnique: async ({ where }: { where: { gcSubscriptionId: string } }) => {
        const row = rows.find((r) => r['gcSubscriptionId'] === where.gcSubscriptionId)
        return row ? { ...row } : null
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rows.push({ ...data })
        return { ...data }
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r['id'] === where.id)!
        Object.assign(row, data)
        return { ...row }
      },
    },
  }
}

describe('recordRecovery', () => {
  it('closes the case as recovered with the amount, method and reference', async () => {
    const db = makeCaseDb({ gcSubscriptionId: 'SB1', status: 'chasing' })
    const now = new Date('2026-06-20T12:00:00Z')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
    const result = await recordRecovery(db as any, {
      gcSubscriptionId: 'SB1',
      recoveredMinor: 80_000,
      method: 'bank_transfer',
      ref: 'INV-123',
      actorId: 'u1',
      now,
    })
    expect(result.status).toBe('recovered')
    expect(result.recoveredMinor).toBe(80_000)
    expect(result.recoveryMethod).toBe('bank_transfer')
    expect(result.recoveryRef).toBe('INV-123')
    expect(result.recoveredAt).toEqual(now)
  })
})

describe('setCaseStatus', () => {
  it('rejects an illegal transition', async () => {
    const db = makeCaseDb({ gcSubscriptionId: 'SB1', status: 'recovered' })
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
      setCaseStatus(db as any, { gcSubscriptionId: 'SB1', to: 'escalated', actorId: 'u1' }),
    ).rejects.toBeInstanceOf(CaseTransitionError)
  })

  it('applies a legal transition', async () => {
    const db = makeCaseDb({ gcSubscriptionId: 'SB1', status: 'new' })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
    const r = await setCaseStatus(db as any, {
      gcSubscriptionId: 'SB1',
      to: 'chasing',
      actorId: 'u1',
    })
    expect(r.from).toBe('new')
    expect(r.case.status).toBe('chasing')
  })
})

describe('canTransition', () => {
  it('walks the open flow new → chasing → escalated', () => {
    expect(canTransition('new', 'chasing')).toBe(true)
    expect(canTransition('chasing', 'escalated')).toBe(true)
    expect(canTransition('escalated', 'chasing')).toBe(true)
  })

  it('allows closing from any open state', () => {
    for (const from of ['new', 'chasing', 'escalated'] as const) {
      expect(canTransition(from, 'recovered')).toBe(true)
      expect(canTransition(from, 'written_off')).toBe(true)
    }
  })

  it('allows reopening a closed case back to chasing', () => {
    expect(canTransition('recovered', 'chasing')).toBe(true)
    expect(canTransition('written_off', 'chasing')).toBe(true)
  })

  it('rejects no-op and illegal moves', () => {
    expect(canTransition('chasing', 'chasing')).toBe(false)
    expect(canTransition('recovered', 'written_off')).toBe(false)
    expect(canTransition('recovered', 'escalated')).toBe(false)
    expect(canTransition('new', 'new')).toBe(false)
  })
})

describe('isClosedStatus', () => {
  it('treats recovered and written_off as closed', () => {
    expect(isClosedStatus('recovered')).toBe(true)
    expect(isClosedStatus('written_off')).toBe(true)
    expect(isClosedStatus('new')).toBe(false)
    expect(isClosedStatus('chasing')).toBe(false)
    expect(isClosedStatus('escalated')).toBe(false)
  })
})
