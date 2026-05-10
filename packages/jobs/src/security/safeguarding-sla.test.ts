// Tests for the safeguarding SLA escalator. Pure logic + in-memory DB fake.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  escalateOnce,
  isBreached,
  pagerDutySeverityFor,
  resolveDeputyDsl,
  type FlagForSla,
  type PagerDutyTrigger,
  type SafeguardingSlaDb,
} from './safeguarding-sla'

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

interface State {
  flags: FlagForSla[]
  rota: Array<{ userId: string; weekStart: Date; weekEnd: Date; role: 'primary' | 'deputy' }>
}

function makeDb(state: State): SafeguardingSlaDb {
  return {
    safeguardingFlag: {
      findMany: async ({ where, take, select }) => {
        const filtered = state.flags.filter(
          (f) => f.state === where.state && f.escalatedAt === where.escalatedAt,
        )
        const _select = select // not actually projected; tests use the raw row
        void _select
        return filtered.slice(0, take)
      },
      update: async ({ where, data }) => {
        const f = state.flags.find((x) => x.id === where.id)
        if (!f) throw new Error('not found')
        f.escalatedAt = data.escalatedAt
        f.dslUserId = data.dslUserId
        return { id: f.id }
      },
    },
    dslRota: {
      findFirst: async ({ where }) => {
        const row = state.rota.find(
          (r) =>
            r.role === where.role &&
            r.weekStart <= where.weekStart.lte &&
            r.weekEnd >= where.weekEnd.gte,
        )
        return row ? { userId: row.userId } : null
      },
    },
  }
}

function flag(partial: Partial<FlagForSla> & { id: string; urgency: FlagForSla['urgency']; createdAt: Date }): FlagForSla {
  return {
    contactId: 'c-1',
    state: 'concern_logged',
    acknowledgedAt: null,
    escalatedAt: null,
    dslUserId: 'dsl-primary',
    ...partial,
  }
}

function makePd(): { trigger: PagerDutyTrigger['trigger']; calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    trigger: async (input) => void calls.push(input),
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('isBreached', () => {
  const now = new Date('2026-05-10T12:00:00Z')
  it('returns false for a routine flag <4h old', () => {
    expect(isBreached({ urgency: 'routine', createdAt: new Date('2026-05-10T11:00:00Z') }, now)).toBe(
      false,
    )
  })
  it('returns true for a routine flag >4h old', () => {
    expect(isBreached({ urgency: 'routine', createdAt: new Date('2026-05-10T07:00:00Z') }, now)).toBe(
      true,
    )
  })
  it('returns true for an immediate flag >15min old', () => {
    expect(
      isBreached({ urgency: 'immediate', createdAt: new Date('2026-05-10T11:30:00Z') }, now),
    ).toBe(true)
  })
})

describe('pagerDutySeverityFor', () => {
  it('maps immediate to critical and the rest to error', () => {
    expect(pagerDutySeverityFor('immediate')).toBe('critical')
    expect(pagerDutySeverityFor('urgent')).toBe('error')
    expect(pagerDutySeverityFor('routine')).toBe('error')
  })
})

describe('resolveDeputyDsl', () => {
  const now = new Date('2026-05-10T12:00:00Z')
  it('returns the rota deputy when present', async () => {
    const db = makeDb({
      flags: [],
      rota: [
        {
          userId: 'deputy-of-the-week',
          weekStart: new Date('2026-05-04T00:00:00Z'),
          weekEnd: new Date('2026-05-11T00:00:00Z'),
          role: 'deputy',
        },
      ],
    })
    expect(await resolveDeputyDsl(db, now)).toBe('deputy-of-the-week')
  })

  it('falls back to DEPUTY_DSL_USER_ID env when rota empty', async () => {
    const db = makeDb({ flags: [], rota: [] })
    process.env['DEPUTY_DSL_USER_ID'] = 'env-deputy'
    try {
      expect(await resolveDeputyDsl(db, now)).toBe('env-deputy')
    } finally {
      delete process.env['DEPUTY_DSL_USER_ID']
    }
  })

  it('throws when no deputy is configured anywhere', async () => {
    const db = makeDb({ flags: [], rota: [] })
    await expect(resolveDeputyDsl(db, now)).rejects.toThrow(/No deputy DSL/)
  })
})

describe('escalateOnce', () => {
  const now = new Date('2026-05-10T12:00:00Z')
  const rotaDeputy = {
    userId: 'deputy-1',
    weekStart: new Date('2026-05-04T00:00:00Z'),
    weekEnd: new Date('2026-05-11T00:00:00Z'),
    role: 'deputy' as const,
  }

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('skips non-breached flags', async () => {
    const state: State = {
      flags: [flag({ id: 'f1', urgency: 'routine', createdAt: new Date('2026-05-10T11:30:00Z') })],
      rota: [rotaDeputy],
    }
    const pd = makePd()
    const r = await escalateOnce(makeDb(state), now, { trigger: pd.trigger })
    expect(r.escalated).toBe(0)
    expect(r.skipped).toBe(1)
    expect(pd.calls).toHaveLength(0)
    expect(state.flags[0]!.escalatedAt).toBeNull()
  })

  it('escalates a breached + unack flag and reassigns to deputy', async () => {
    const state: State = {
      flags: [
        flag({
          id: 'f2',
          urgency: 'immediate',
          createdAt: new Date('2026-05-10T11:30:00Z'), // 30 min ago > 15 min SLA
        }),
      ],
      rota: [rotaDeputy],
    }
    const pd = makePd()
    const audit: { entries: unknown[] } = { entries: [] }
    const r = await escalateOnce(
      makeDb(state),
      now,
      { trigger: pd.trigger },
      { write: async (e) => void audit.entries.push(e) },
    )
    expect(r.escalated).toBe(1)
    expect(pd.calls).toHaveLength(1)
    expect((pd.calls[0] as { severity: string }).severity).toBe('critical')
    expect((pd.calls[0] as { dedupKey: string }).dedupKey).toBe('sg-sla:f2')
    expect(state.flags[0]!.dslUserId).toBe('deputy-1')
    expect(state.flags[0]!.escalatedAt).toEqual(now)
    expect(
      (audit.entries as Array<{ action: string }>).some(
        (e) => e.action === 'safeguarding.sla_breached',
      ),
    ).toBe(true)
  })

  it('is idempotent — already-escalated flags are filtered out by the query', async () => {
    const state: State = {
      flags: [
        flag({
          id: 'f3',
          urgency: 'immediate',
          createdAt: new Date('2026-05-10T11:00:00Z'),
          escalatedAt: new Date('2026-05-10T11:30:00Z'),
        }),
      ],
      rota: [rotaDeputy],
    }
    const pd = makePd()
    const r = await escalateOnce(makeDb(state), now, { trigger: pd.trigger })
    // findMany filter selects escalatedAt === null only.
    expect(r.scanned).toBe(0)
    expect(pd.calls).toHaveLength(0)
  })

  it('skips acknowledged flags', async () => {
    const state: State = {
      flags: [
        flag({
          id: 'f4',
          urgency: 'urgent',
          createdAt: new Date('2026-05-10T10:00:00Z'),
          acknowledgedAt: new Date('2026-05-10T10:30:00Z'),
        }),
      ],
      rota: [rotaDeputy],
    }
    const pd = makePd()
    const r = await escalateOnce(makeDb(state), now, { trigger: pd.trigger })
    expect(r.escalated).toBe(0)
    expect(r.skipped).toBe(1)
    expect(pd.calls).toHaveLength(0)
  })
})
