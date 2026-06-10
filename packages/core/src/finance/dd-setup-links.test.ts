// Unit tests for durable Direct Debit setup links (ADR 0038 amendment).
// The lifecycle rules are what matter: openability, lazy expiry, one-reminder
// automation, and idempotent completion. In-memory fake Prisma client,
// matching gc-mirror.test.ts. Clock injected throughout (CLAUDE.md §30).

import { describe, expect, it } from 'vitest'

import {
  completeSetupLink,
  createMandateSetupLink,
  expireStaleSetupLinks,
  generateSetupLinkToken,
  listSetupLinkReminderCandidates,
  resolveSetupLinkForOpen,
  revokeSetupLink,
  SETUP_LINK_REMINDER_AFTER_DAYS,
  SETUP_LINK_TTL_DAYS,
  setupLinkOpenState,
} from './dd-setup-links'

const T0 = new Date('2026-06-10T10:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

function daysAfter(days: number): Date {
  return new Date(T0.getTime() + days * DAY_MS)
}

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb() {
  const links: FakeRow[] = []
  const db = {
    mandateSetupLink: {
      create: ({ data, select }: { data: Record<string, unknown>; select?: unknown }) => {
        const row = {
          deletedAt: null,
          emailedAt: null,
          reminderSentAt: null,
          openCount: 0,
          ...data,
        } as unknown as FakeRow
        links.push(row)
        void select
        return Promise.resolve(row)
      },
      findUnique: ({ where }: { where: { token?: string; id?: string } }) =>
        Promise.resolve(
          links.find((l) =>
            where.token ? l['token'] === where.token : l.id === where.id,
          ) ?? null,
        ),
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(links.find((l) => l.id === where.id) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = links.find((l) => l.id === where.id)!
        const patch = { ...data } as Record<string, unknown>
        const openInc = (patch['openCount'] as { increment?: number } | undefined)?.increment
        if (openInc) patch['openCount'] = (row['openCount'] as number) + openInc
        Object.assign(row, patch)
        return Promise.resolve(row)
      },
      updateMany: ({
        where,
        data,
      }: {
        where: {
          id?: string
          status?: string | { in: string[] }
          expiresAt?: { lte: Date }
          deletedAt?: null
        }
        data: Record<string, unknown>
      }) => {
        const matches = links.filter((l) => {
          if (where.id && l.id !== where.id) return false
          if (typeof where.status === 'string' && l['status'] !== where.status) return false
          if (
            where.status &&
            typeof where.status === 'object' &&
            !where.status.in.includes(l['status'] as string)
          ) {
            return false
          }
          if (where.expiresAt && (l['expiresAt'] as Date) > where.expiresAt.lte) return false
          if (where.deletedAt === null && l['deletedAt'] !== null) return false
          return true
        })
        matches.forEach((m) => Object.assign(m, data))
        return Promise.resolve({ count: matches.length })
      },
      findMany: ({
        where,
      }: {
        where: {
          status: string
          emailedAt?: { not: null; lte: Date }
          reminderSentAt?: null
          emailTo?: { not: null }
          expiresAt?: { gt: Date }
        }
      }) =>
        Promise.resolve(
          links.filter((l) => {
            if (l['status'] !== where.status) return false
            if (l['deletedAt'] !== null) return false
            if (where.emailedAt) {
              const at = l['emailedAt'] as Date | null
              if (!at || at > where.emailedAt.lte) return false
            }
            if (where.reminderSentAt === null && l['reminderSentAt'] !== null) return false
            if (where.emailTo && l['emailTo'] === null) return false
            if (where.expiresAt && (l['expiresAt'] as Date) <= where.expiresAt.gt) return false
            return true
          }),
        ),
    },
    _links: links,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake
  return db as any
}

describe('generateSetupLinkToken', () => {
  it('produces unguessable url-safe tokens', () => {
    const a = generateSetupLinkToken()
    const b = generateSetupLinkToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
  })
})

describe('setupLinkOpenState (pure)', () => {
  const base = { status: 'active', expiresAt: daysAfter(7) }
  it('active + in date → openable', () => {
    expect(setupLinkOpenState(base, T0)).toBe('openable')
  })
  it('past expiry → expired, even while status still says active', () => {
    expect(setupLinkOpenState(base, daysAfter(8))).toBe('expired')
  })
  it('terminal statuses win', () => {
    expect(setupLinkOpenState({ ...base, status: 'completed' }, T0)).toBe('completed')
    expect(setupLinkOpenState({ ...base, status: 'revoked' }, T0)).toBe('revoked')
  })
})

describe('lifecycle against the fake db', () => {
  it('creates with a 14-day expiry and resolves for open', async () => {
    const db = makeFakeDb()
    const link = await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      emailTo: 'parent@example.com',
      actorId: 'agent1',
      now: T0,
    })
    expect(link.expiresAt.getTime()).toBe(T0.getTime() + SETUP_LINK_TTL_DAYS * DAY_MS)

    const resolved = await resolveSetupLinkForOpen(db, link.token, daysAfter(1))
    expect(resolved.ok).toBe(true)
  })

  it('lazily expires a past-expiry link on open', async () => {
    const db = makeFakeDb()
    const link = await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      actorId: 'agent1',
      now: T0,
    })
    const resolved = await resolveSetupLinkForOpen(db, link.token, daysAfter(15))
    expect(resolved).toEqual({ ok: false, reason: 'expired' })
    expect(db._links[0]['status']).toBe('expired')
  })

  it('reminder goes to links emailed ≥3 days ago with no reminder yet — once', async () => {
    const db = makeFakeDb()
    const link = await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      emailTo: 'parent@example.com',
      actorId: 'agent1',
      now: T0,
    })
    db._links[0]['emailedAt'] = T0

    const tooSoon = await listSetupLinkReminderCandidates(db, daysAfter(1))
    expect(tooSoon).toHaveLength(0)

    const due = await listSetupLinkReminderCandidates(
      db,
      daysAfter(SETUP_LINK_REMINDER_AFTER_DAYS),
    )
    expect(due.map((d) => d.id)).toEqual([link.id])

    db._links[0]['reminderSentAt'] = daysAfter(3)
    const after = await listSetupLinkReminderCandidates(db, daysAfter(5))
    expect(after).toHaveLength(0)
  })

  it('completion is idempotent and closes the reminder loop', async () => {
    const db = makeFakeDb()
    const link = await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      emailTo: 'parent@example.com',
      actorId: 'agent1',
      now: T0,
    })
    db._links[0]['emailedAt'] = T0

    await completeSetupLink(db, { setupLinkId: link.id, gcMandateId: 'MD1', now: daysAfter(1) })
    await completeSetupLink(db, { setupLinkId: link.id, gcMandateId: 'MD1', now: daysAfter(2) })
    expect(db._links[0]['status']).toBe('completed')
    expect(db._links[0]['gcMandateId']).toBe('MD1')

    const due = await listSetupLinkReminderCandidates(db, daysAfter(4))
    expect(due).toHaveLength(0)
  })

  it('expireStaleSetupLinks flips only past-expiry active links', async () => {
    const db = makeFakeDb()
    await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      actorId: 'a',
      now: T0,
    })
    await createMandateSetupLink(db, {
      contactId: 'c2',
      familyId: 'f2',
      actorId: 'a',
      now: daysAfter(10),
    })
    const count = await expireStaleSetupLinks(db, daysAfter(15))
    expect(count).toBe(1)
    expect(db._links[0]['status']).toBe('expired')
    expect(db._links[1]['status']).toBe('active')
  })

  it('revoke only works on active links', async () => {
    const db = makeFakeDb()
    const link = await createMandateSetupLink(db, {
      contactId: 'c1',
      familyId: 'f1',
      actorId: 'a',
      now: T0,
    })
    expect((await revokeSetupLink(db, { setupLinkId: link.id, actorId: 'a' })).ok).toBe(true)
    expect((await revokeSetupLink(db, { setupLinkId: link.id, actorId: 'a' })).ok).toBe(false)
    expect((await revokeSetupLink(db, { setupLinkId: 'ghost', actorId: 'a' })).ok).toBe(false)
  })
})
