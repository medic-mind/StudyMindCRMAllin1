// Sign-in lockout primitives. ADR 0010, CLAUDE.md §44.2 ("compromised agent").
//
// Five consecutive failed sign-ins lock the account for 15 minutes. The
// counter resets on a successful sign-in. Each transition writes an audit
// row so we can trace credential-stuffing attempts in incident review.

import type { PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

const FAILURE_THRESHOLD = 5
const LOCK_WINDOW_MS = 15 * 60 * 1000

export interface LockableUser {
  id: string
  failedSignInAttempts: number
  lockedUntil: Date | null
}

export interface SignInTelemetry {
  ip?: string | null
  ua?: string | null
}

export interface LockoutResult {
  locked: boolean
  lockedUntil?: Date
}

/**
 * Increment the failed-attempt counter. When the threshold is reached, the
 * account is locked for LOCK_WINDOW_MS and an audit row is written.
 */
export async function recordFailedAttempt(
  user: LockableUser,
  db: PrismaClient,
  now: Date = new Date(),
): Promise<LockoutResult> {
  const nextCount = user.failedSignInAttempts + 1
  const reachesThreshold = nextCount >= FAILURE_THRESHOLD
  const lockedUntil = reachesThreshold ? new Date(now.getTime() + LOCK_WINDOW_MS) : null

  await db.user.update({
    where: { id: user.id },
    data: {
      failedSignInAttempts: nextCount,
      lockedUntil,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: null,
    action: reachesThreshold ? 'auth.account_locked' : 'auth.signin_failed',
    target: { type: 'User', id: user.id },
    after: { failedSignInAttempts: nextCount, lockedUntil },
  })

  return reachesThreshold
    ? { locked: true, lockedUntil: lockedUntil! }
    : { locked: false }
}

/**
 * Reset the failed-attempt counter and stamp the last-sign-in fields. Called
 * by the Credentials provider after a successful authorize().
 */
export async function recordSuccessfulSignIn(
  user: LockableUser,
  db: PrismaClient,
  telemetry: SignInTelemetry,
  now: Date = new Date(),
): Promise<void> {
  await db.user.update({
    where: { id: user.id },
    data: {
      failedSignInAttempts: 0,
      lockedUntil: null,
      lastSignInAt: now,
      lastSignInIp: telemetry.ip ?? null,
      lastSignInUa: telemetry.ua ?? null,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: user.id,
    action: 'auth.signin_succeeded',
    target: { type: 'User', id: user.id },
    after: { ip: telemetry.ip ?? null, ua: telemetry.ua ?? null },
  })
}

/** Throws BusinessError('ACCOUNT_LOCKED') if the user is currently locked. */
export function assertNotLocked(user: LockableUser, now: Date = new Date()): void {
  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    throw new BusinessError('ACCOUNT_LOCKED', 'Account is temporarily locked.', {
      lockedUntil: user.lockedUntil.toISOString(),
    })
  }
}
