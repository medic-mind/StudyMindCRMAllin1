import { describe, expect, it } from 'vitest'

import { canAccessMailAccount } from './account-access'

// A minimal fake of the two delegates the predicate reads.
function fakeDb(opts: {
  accounts: Array<{ id: string; ownerUserId: string | null }>
  members: Array<{ mailAccountId: string; userId: string }>
}) {
  return {
    mailAccount: {
      findFirst: async ({ where }: { where: { id: string } }) =>
        opts.accounts.find((a) => a.id === where.id) ?? null,
    },
    mailAccountMember: {
      findFirst: async ({ where }: { where: { mailAccountId: string; userId: string } }) =>
        opts.members.find(
          (m) => m.mailAccountId === where.mailAccountId && m.userId === where.userId,
        ) ?? null,
    },
  } as never
}

describe('canAccessMailAccount', () => {
  const db = fakeDb({
    accounts: [
      { id: 'personal_boss', ownerUserId: 'u_boss' },
      { id: 'shared_info', ownerUserId: 'u_boss' },
    ],
    members: [{ mailAccountId: 'shared_info', userId: 'u_member' }],
  })

  it('lets a manager see any mailbox', async () => {
    expect(await canAccessMailAccount(db, { id: 'u_x', role: 'manager' }, 'personal_boss')).toBe(true)
    expect(await canAccessMailAccount(db, { id: 'u_x', role: 'ceo' }, 'personal_boss')).toBe(true)
  })

  it('lets the owner see their own mailbox', async () => {
    expect(
      await canAccessMailAccount(db, { id: 'u_boss', role: 'sales_executive' }, 'personal_boss'),
    ).toBe(true)
  })

  it('lets a shared-inbox member see it', async () => {
    expect(
      await canAccessMailAccount(db, { id: 'u_member', role: 'virtual_assistant' }, 'shared_info'),
    ).toBe(true)
  })

  it('DENIES a non-owner / non-member / non-manager (the breach)', async () => {
    // A sales_executive who owns nothing and is a member of nothing must not be
    // able to read another agent's personal inbox or a shared inbox by id.
    expect(
      await canAccessMailAccount(db, { id: 'u_stranger', role: 'sales_executive' }, 'personal_boss'),
    ).toBe(false)
    expect(
      await canAccessMailAccount(db, { id: 'u_stranger', role: 'virtual_assistant' }, 'shared_info'),
    ).toBe(false)
  })

  it('denies a non-manager on a null / unknown account', async () => {
    expect(await canAccessMailAccount(db, { id: 'u_x', role: 'sales_executive' }, null)).toBe(false)
    expect(await canAccessMailAccount(db, { id: 'u_x', role: 'sales_executive' }, 'nope')).toBe(false)
  })
})
