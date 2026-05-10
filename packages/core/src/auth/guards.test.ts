// Tests for the role-mutation guards. CLAUDE.md §20, ADR 0009.

import { describe, expect, it, vi } from 'vitest'

import { BusinessError } from '../errors'
import { assertNotLastSuperAdmin, type RoleAssignmentCounter } from './guards'

function makeDb(otherSuperAdmins: number): RoleAssignmentCounter {
  return {
    roleAssignment: {
      count: vi.fn().mockResolvedValue(otherSuperAdmins),
    },
  }
}

describe('assertNotLastSuperAdmin', () => {
  it('passes when other super_admins exist', async () => {
    const db = makeDb(2)
    await expect(assertNotLastSuperAdmin(db, 'u_1')).resolves.toBeUndefined()
    expect(db.roleAssignment.count).toHaveBeenCalledWith({
      where: { role: 'super_admin', userId: { not: 'u_1' } },
    })
  })

  it('throws LAST_SUPER_ADMIN when no other super_admins remain', async () => {
    const db = makeDb(0)
    await expect(assertNotLastSuperAdmin(db, 'u_1')).rejects.toBeInstanceOf(
      BusinessError,
    )
    await expect(assertNotLastSuperAdmin(db, 'u_1')).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN',
    })
  })
})
