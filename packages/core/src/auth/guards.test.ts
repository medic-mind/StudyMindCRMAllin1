// Tests for the role-mutation guards. CLAUDE.md §20, ADR 0014.

import { describe, expect, it, vi } from 'vitest'

import { BusinessError } from '../errors'
import { assertNotLastCeo, type RoleAssignmentCounter } from './guards'

function makeDb(otherCeos: number): RoleAssignmentCounter & {
  roleAssignment: { count: ReturnType<typeof vi.fn> }
} {
  return {
    roleAssignment: {
      count: vi.fn().mockResolvedValue(otherCeos),
    },
  }
}

describe('assertNotLastCeo', () => {
  it('passes when other ceos exist', async () => {
    const db = makeDb(2)
    await expect(assertNotLastCeo(db, 'u_1')).resolves.toBeUndefined()
    expect(db.roleAssignment.count).toHaveBeenCalledWith({
      where: { role: { in: ['ceo', 'super_admin'] }, userId: { not: 'u_1' } },
    })
  })

  it('throws LAST_CEO when no other ceos remain', async () => {
    const db = makeDb(0)
    await expect(assertNotLastCeo(db, 'u_1')).rejects.toBeInstanceOf(BusinessError)
    await expect(assertNotLastCeo(db, 'u_1')).rejects.toMatchObject({
      code: 'LAST_CEO',
    })
  })
})
