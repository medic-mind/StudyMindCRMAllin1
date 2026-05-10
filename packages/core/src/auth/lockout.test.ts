import { describe, expect, it, vi } from 'vitest'

import { BusinessError } from '../errors'

import {
  assertNotLocked,
  recordFailedAttempt,
  recordSuccessfulSignIn,
  type LockableUser,
} from './lockout'

interface FakeUserRow extends LockableUser {
  lastSignInAt?: Date | null
  lastSignInIp?: string | null
  lastSignInUa?: string | null
}

function makeDb(initial: FakeUserRow) {
  const userRow: FakeUserRow = { ...initial }
  const auditRows: Array<{ action: string; targetId: string; after: unknown }> = []

  const userUpdate = vi.fn(async (args: { where: { id: string }; data: Partial<FakeUserRow> }) => {
    Object.assign(userRow, args.data)
    return userRow
  })

  const auditFindFirst = vi.fn(async () => null)
  const auditCreate = vi.fn(async (args: { data: { action: string; targetId: string; after: unknown } }) => {
    auditRows.push({ action: args.data.action, targetId: args.data.targetId, after: args.data.after })
    return args.data
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    user: { update: userUpdate },
    auditLogEntry: { findFirst: auditFindFirst, create: auditCreate },
  }
  return { db, userRow, auditRows, userUpdate }
}

describe('lockout', () => {
  describe('recordFailedAttempt', () => {
    it('increments counter without locking below threshold', async () => {
      const { db, userRow, auditRows } = makeDb({
        id: 'u_1',
        failedSignInAttempts: 0,
        lockedUntil: null,
      })
      const result = await recordFailedAttempt(
        { id: 'u_1', failedSignInAttempts: 0, lockedUntil: null },
        db,
      )
      expect(result.locked).toBe(false)
      expect(userRow.failedSignInAttempts).toBe(1)
      expect(userRow.lockedUntil).toBeNull()
      expect(auditRows[0]?.action).toBe('auth.signin_failed')
    })

    it('locks the account on the 5th attempt', async () => {
      const { db, userRow, auditRows } = makeDb({
        id: 'u_1',
        failedSignInAttempts: 4,
        lockedUntil: null,
      })
      const now = new Date('2026-05-10T12:00:00Z')
      const result = await recordFailedAttempt(
        { id: 'u_1', failedSignInAttempts: 4, lockedUntil: null },
        db,
        now,
      )
      expect(result.locked).toBe(true)
      expect(userRow.failedSignInAttempts).toBe(5)
      expect(userRow.lockedUntil?.getTime()).toBe(now.getTime() + 15 * 60 * 1000)
      expect(auditRows[0]?.action).toBe('auth.account_locked')
    })
  })

  describe('recordSuccessfulSignIn', () => {
    it('resets counters and stamps last sign-in fields', async () => {
      const { db, userRow, auditRows } = makeDb({
        id: 'u_1',
        failedSignInAttempts: 3,
        lockedUntil: null,
      })
      const now = new Date('2026-05-10T12:00:00Z')
      await recordSuccessfulSignIn(
        { id: 'u_1', failedSignInAttempts: 3, lockedUntil: null },
        db,
        { ip: '203.0.113.1', ua: 'Mozilla' },
        now,
      )
      expect(userRow.failedSignInAttempts).toBe(0)
      expect(userRow.lockedUntil).toBeNull()
      expect(userRow.lastSignInAt).toEqual(now)
      expect(userRow.lastSignInIp).toBe('203.0.113.1')
      expect(auditRows[0]?.action).toBe('auth.signin_succeeded')
    })
  })

  describe('assertNotLocked', () => {
    it('passes when not locked', () => {
      expect(() =>
        assertNotLocked({ id: 'u', failedSignInAttempts: 0, lockedUntil: null }),
      ).not.toThrow()
    })
    it('passes when lockedUntil is in the past', () => {
      expect(() =>
        assertNotLocked(
          { id: 'u', failedSignInAttempts: 5, lockedUntil: new Date('2020-01-01') },
          new Date('2026-05-10T12:00:00Z'),
        ),
      ).not.toThrow()
    })
    it('throws when lockedUntil is in the future', () => {
      expect(() =>
        assertNotLocked(
          {
            id: 'u',
            failedSignInAttempts: 5,
            lockedUntil: new Date('2030-01-01'),
          },
          new Date('2026-05-10T12:00:00Z'),
        ),
      ).toThrow(BusinessError)
    })
  })
})
