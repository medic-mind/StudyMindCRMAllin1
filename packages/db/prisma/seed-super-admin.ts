// Seed the initial super_admin (Aashir by default). Idempotent.
// CLAUDE.md §20, ADR 0009, ADR 0010.
//
// Two paths:
//   1. INITIAL_SUPER_ADMIN_PASSWORD set → bcrypt-hash and store the
//      password, mark email verified, set mustResetPassword=true so the
//      user picks their own on first sign-in.
//   2. Otherwise → leave passwordHash null, issue an EmailVerificationToken
//      with 7-day TTL, and print the accept-invite link to stdout for
//      out-of-band delivery.
//
// Re-running is safe: an existing super_admin RoleAssignment is left in
// place, an existing User row is patched (not duplicated).
//
// This script is intentionally self-contained — it does not import from
// @studymind/audit or @studymind/core to avoid a workspace dependency
// cycle (those packages depend on @studymind/db). Bcrypt + sha256 are
// inlined; the audit row is written directly to the AuditLogEntry table.

import { createHash, randomBytes } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import bcrypt from 'bcryptjs'

import { db } from '../src/index'

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const BCRYPT_COST = 12

function generateToken(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export interface SeedResult {
  userId: string
  email: string
  status: 'password-set' | 'needs-link' | 'already-seeded'
  inviteUrl?: string
  alreadySuperAdmin: boolean
}

export async function seedInitialSuperAdmin(): Promise<SeedResult> {
  const email = (
    process.env['INITIAL_SUPER_ADMIN_EMAIL'] ?? 'aashir@studymind.co.uk'
  )
    .trim()
    .toLowerCase()
  const name = (process.env['INITIAL_SUPER_ADMIN_NAME'] ?? 'Aashir').trim()
  const password = process.env['INITIAL_SUPER_ADMIN_PASSWORD']
  const appUrl = (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')

  // Find or create the User row.
  let user = await db.user.findUnique({ where: { email } })
  if (!user) {
    user = await db.user.create({
      data: {
        id: createId(),
        email,
        name,
        passwordHash: null,
        emailVerifiedAt: null,
        mustResetPassword: false,
      },
    })
  } else if (!user.name && name) {
    user = await db.user.update({
      where: { id: user.id },
      data: { name },
    })
  }

  // Idempotently ensure a super_admin RoleAssignment exists.
  const existingRole = await db.roleAssignment.findUnique({
    where: { userId_role: { userId: user.id, role: 'super_admin' } },
  })
  const alreadySuperAdmin = !!existingRole
  if (!existingRole) {
    await db.roleAssignment.create({
      data: {
        id: createId(),
        userId: user.id,
        role: 'super_admin',
      },
    })
  }

  let status: SeedResult['status']
  let inviteUrl: string | undefined

  if (password) {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST)
    await db.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        emailVerifiedAt: new Date(),
        mustResetPassword: true,
        failedSignInAttempts: 0,
        lockedUntil: null,
      },
    })
    status = 'password-set'
  } else if (!user.passwordHash) {
    const rawToken = generateToken()
    await db.emailVerificationToken.create({
      data: {
        id: createId(),
        userId: user.id,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    })
    inviteUrl = `${appUrl}/accept-invite?token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`
    status = 'needs-link'
  } else {
    status = 'already-seeded'
  }

  // Inline audit write — the regular writeAuditLogEntry helper lives in
  // @studymind/audit which depends on @studymind/db, so we cannot import
  // it from here without creating a cycle.
  await db.auditLogEntry.create({
    data: {
      id: createId(),
      actorId: null,
      action: 'auth.super_admin_seeded',
      targetType: 'User',
      targetId: user.id,
      requestId: null,
      after: { email, status, alreadySuperAdmin },
    },
  })

  return {
    userId: user.id,
    email,
    status,
    inviteUrl,
    alreadySuperAdmin,
  }
}

async function main(): Promise<void> {
  const result = await seedInitialSuperAdmin()
  /* eslint-disable no-console */
  console.log('---')
  console.log('Initial super_admin seed')
  console.log(`  user:     ${result.email} (${result.userId})`)
  console.log(
    `  role:     super_admin ${result.alreadySuperAdmin ? '(already present)' : '(granted)'}`,
  )
  if (result.status === 'password-set') {
    console.log('  status:   password set from INITIAL_SUPER_ADMIN_PASSWORD')
    console.log('  next:     user must reset their password on first sign-in')
  } else if (result.status === 'needs-link') {
    console.log('  status:   no password set — invite link below (valid 7 days)')
    console.log(`  link:     ${result.inviteUrl}`)
  } else {
    console.log('  status:   account already has a password — no changes')
  }
  console.log('---')
  /* eslint-enable no-console */
}

const isDirect = (() => {
  const argv1 = process.argv[1] ?? ''
  return argv1.endsWith('seed-super-admin.ts') || argv1.endsWith('seed-super-admin.js')
})()

if (isDirect) {
  main()
    .then(async () => {
      await db.$disconnect()
    })
    .catch(async (err) => {
      // eslint-disable-next-line no-console
      console.error(err)
      await db.$disconnect()
      process.exit(1)
    })
}
