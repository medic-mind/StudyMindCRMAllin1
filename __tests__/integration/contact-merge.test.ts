// Contact merge invariants. CLAUDE.md §3, §35, §41.1.
// Mock-DB integration test — the merge service must:
//  - re-parent Interactions and FamilyMembers to the survivor
//  - soft-delete the loser
//  - refuse when restricted_access flags conflict on DSL assignment

import { describe, expect, it } from 'vitest'

import { BusinessError } from '@studymind/core'
import { mergeContacts } from '../../apps/web/lib/services/contact-merge'

interface Contact {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  kind: string
  deletedAt: Date | null
  updatedById: string | null
  safeguardingFlags: Array<{
    id: string
    state: string
    deletedAt: Date | null
    dslUserId: string | null
  }>
}

interface Interaction {
  id: string
  type: string
  contactId: string | null
  occurredAt: Date
  summary: string | null
  payload: unknown
}

interface FamilyMember {
  id: string
  familyId: string
  contactId: string
}

interface Family {
  id: string
  billingContactId: string | null
}

function makeFakeDb(initial: {
  contacts: Contact[]
  interactions: Interaction[]
  familyMembers: FamilyMember[]
  families: Family[]
}) {
  const state = initial

  const contactStore = {
    findUnique: async ({ where, include }: any) => {
      const c = state.contacts.find(
        (x) => x.id === where.id && (where.deletedAt === null ? !x.deletedAt : true),
      )
      if (!c) return null
      const result: any = { ...c }
      if (include?.safeguardingFlags) {
        result.safeguardingFlags = c.safeguardingFlags.filter(
          (f) =>
            (include.safeguardingFlags.where?.deletedAt === null ? !f.deletedAt : true) &&
            (include.safeguardingFlags.where?.state
              ? f.state === include.safeguardingFlags.where.state
              : true),
        )
      }
      return result
    },
    update: async ({ where, data }: any) => {
      const c = state.contacts.find((x) => x.id === where.id)
      if (!c) throw new Error('not found')
      Object.assign(c, data)
      return c
    },
  }

  const interactionStore = {
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const i of state.interactions) {
        if (i.contactId === where.contactId) {
          i.contactId = data.contactId
          count++
        }
      }
      return { count }
    },
    create: async ({ data }: any) => {
      state.interactions.push(data)
      return data
    },
  }

  const familyMemberStore = {
    findMany: async ({ where }: any) => {
      return state.familyMembers
        .filter((m) => m.contactId === where.contactId)
        .map((m) => ({ id: m.id, familyId: m.familyId }))
    },
    findUnique: async ({ where }: any) => {
      const { familyId, contactId } = where.familyId_contactId
      return (
        state.familyMembers.find(
          (m) => m.familyId === familyId && m.contactId === contactId,
        ) ?? null
      )
    },
    update: async ({ where, data }: any) => {
      const m = state.familyMembers.find((x) => x.id === where.id)
      if (!m) throw new Error('not found')
      Object.assign(m, data)
      return m
    },
    delete: async ({ where }: any) => {
      state.familyMembers = state.familyMembers.filter((x) => x.id !== where.id)
      return null
    },
  }

  const familyStore = {
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const f of state.families) {
        if (f.billingContactId === where.billingContactId) {
          f.billingContactId = data.billingContactId
          count++
        }
      }
      return { count }
    },
  }

  const $transaction = async <T,>(cb: (tx: unknown) => Promise<T>): Promise<T> =>
    cb({
      contact: contactStore,
      interaction: interactionStore,
      familyMember: familyMemberStore,
      family: familyStore,
    })

  return {
    state,
    db: {
      contact: contactStore,
      interaction: interactionStore,
      familyMember: familyMemberStore,
      family: familyStore,
      $transaction,
    } as any,
  }
}

const baseContact = (id: string, overrides: Partial<Contact> = {}): Contact => ({
  id,
  firstName: 'Sam',
  lastName: 'Doe',
  email: null,
  phoneE164: null,
  kind: 'parent',
  deletedAt: null,
  updatedById: null,
  safeguardingFlags: [],
  ...overrides,
})

describe('mergeContacts', () => {
  it('re-parents interactions and family memberships, soft-deletes loser', async () => {
    const { state, db } = makeFakeDb({
      contacts: [baseContact('survivor'), baseContact('loser')],
      interactions: [
        {
          id: 'i1',
          type: 'note',
          contactId: 'loser',
          occurredAt: new Date(),
          summary: null,
          payload: {},
        },
        {
          id: 'i2',
          type: 'call',
          contactId: 'loser',
          occurredAt: new Date(),
          summary: null,
          payload: {},
        },
      ],
      familyMembers: [{ id: 'm1', familyId: 'fam1', contactId: 'loser' }],
      families: [{ id: 'fam1', billingContactId: 'loser' }],
    })

    const res = await mergeContacts(db, {
      survivorId: 'survivor',
      loserId: 'loser',
      actorUserId: 'user1',
    })
    expect(res.movedInteractions).toBe(2)
    expect(state.interactions.filter((i) => i.contactId === 'survivor')).toHaveLength(3) // 2 moved + 1 contact.merged
    expect(state.interactions.some((i) => (i.payload as any).event === 'contact.merged')).toBe(true)
    expect(state.familyMembers[0]?.contactId).toBe('survivor')
    expect(state.families[0]?.billingContactId).toBe('survivor')
    expect(state.contacts.find((c) => c.id === 'loser')?.deletedAt).not.toBeNull()
  })

  it('refuses self-merge', async () => {
    const { db } = makeFakeDb({
      contacts: [baseContact('a')],
      interactions: [],
      familyMembers: [],
      families: [],
    })
    await expect(
      mergeContacts(db, { survivorId: 'a', loserId: 'a', actorUserId: 'u' }),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('refuses when restricted_access flags point at different DSLs', async () => {
    const { db } = makeFakeDb({
      contacts: [
        baseContact('survivor', {
          safeguardingFlags: [
            { id: 'f1', state: 'restricted_access', deletedAt: null, dslUserId: 'dsl-1' },
          ],
        }),
        baseContact('loser', {
          safeguardingFlags: [
            { id: 'f2', state: 'restricted_access', deletedAt: null, dslUserId: 'dsl-2' },
          ],
        }),
      ],
      interactions: [],
      familyMembers: [],
      families: [],
    })
    await expect(
      mergeContacts(db, { survivorId: 'survivor', loserId: 'loser', actorUserId: 'u' }),
    ).rejects.toBeInstanceOf(BusinessError)
  })

  it('refuses when only one side has restricted_access', async () => {
    const { db } = makeFakeDb({
      contacts: [
        baseContact('survivor'),
        baseContact('loser', {
          safeguardingFlags: [
            { id: 'f2', state: 'restricted_access', deletedAt: null, dslUserId: 'dsl-2' },
          ],
        }),
      ],
      interactions: [],
      familyMembers: [],
      families: [],
    })
    await expect(
      mergeContacts(db, { survivorId: 'survivor', loserId: 'loser', actorUserId: 'u' }),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})
