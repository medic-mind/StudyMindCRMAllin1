#!/usr/bin/env tsx
// Create (or promote) a full-admin CRM account for ANY email address.
//
// `seed-super-admin.ts` bootstraps the ONE canonical CEO row and is driven by
// SUPER_ADMIN_* env vars, so using it to add a second admin means repointing
// the bootstrap identity on every future deploy. This script is the general
// case: give it an email, get a working admin login, run it as many times as
// you need. It is the CLI counterpart of Settings → Users (CLAUDE.md §20) for
// when nobody can sign in yet.
//
// Usage (project root, or a Railway shell on the `web` service):
//   pnpm create-admin someone@example.com
//   pnpm create-admin someone@example.com "Their Name"
//   ADMIN_ROLE=senior_manager pnpm create-admin someone@example.com
//
// Behaviour, mirroring the security posture of the CEO seed (2026-07):
//
//   • NEW user: created with ADMIN_PASSWORD if set (>= 12 chars, 3 of 4
//     character classes), otherwise a strong random password is GENERATED and
//     printed ONCE. `mustResetPassword` is true so it must be changed on first
//     login (opt out with ADMIN_SKIP_FORCE_RESET=true).
//
//   • EXISTING user: the password is LEFT ALONE — re-running only ensures the
//     role assignment exists, so this is safe to repeat. To reset a password
//     you must ask explicitly: ADMIN_PASSWORD + ADMIN_FORCE_PASSWORD_RESET=true
//     (that path also clears lockout/deactivation so a locked-out admin can get
//     back in). Never resets a password as a side effect (CLAUDE.md §3).
//
// Env vars (all optional):
//   ADMIN_EMAIL                  used when no CLI argument is given
//   ADMIN_NAME                   display name (create only)
//   ADMIN_ROLE                   default 'ceo'; any canonical UserRole
//   ADMIN_PASSWORD               password to set (see rules above)
//   ADMIN_FORCE_PASSWORD_RESET   'true' to overwrite an EXISTING password
//   ADMIN_SKIP_FORCE_RESET       'true' to NOT force a first-login change
//
// Like the seed, this file deliberately does not import @studymind/core or
// @studymind/audit (both depend on @studymind/db — a workspace cycle), so the
// password generator and strength check are inlined.

import { randomInt } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import bcrypt from 'bcryptjs'

import { db } from '../src/index'

const BCRYPT_COST = 12
const MIN_PASSWORD_LENGTH = 12

/** Canonical sales-CRM roles (ADR 0014). Legacy enum values are deliberately
 *  not offered here — new grants should always use a canonical role. */
const CANONICAL_ROLES = [
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
] as const

export type CanonicalRole = (typeof CANONICAL_ROLES)[number]

// Unambiguous character classes (0/O/1/l/I dropped so a printed temp password
// transcribes cleanly), one guaranteed member of each so the result always
// satisfies the app's strong-password policy.
const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*-_?'
const ALL = LOWER + UPPER + DIGIT + SYMBOL

function generateStrongPassword(length = 20): string {
  const chars = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGIT[randomInt(DIGIT.length)],
    SYMBOL[randomInt(SYMBOL.length)],
  ]
  while (chars.length < length) chars.push(ALL[randomInt(ALL.length)])
  // Fisher–Yates shuffle so the guaranteed class members aren't always leading.
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/** Minimal inline strength check (>= 12 chars, >= 3 of 4 classes). Mirrors
 *  packages/core assertStrongPassword without importing it (dep cycle). */
export function assertUsablePassword(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (got ${pw.length}).`,
    )
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (classes < 3) {
    throw new Error('ADMIN_PASSWORD must use at least 3 of: lowercase, uppercase, digit, symbol.')
  }
}

export function normaliseEmail(raw: string): string {
  const email = raw.trim().toLowerCase()
  // Deliberately loose — the DB unique index is the real guard. This only
  // catches an obviously wrong argument (a name, a flag) before we write.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`'${raw}' does not look like an email address.`)
  }
  return email
}

export function parseRole(raw: string | undefined): CanonicalRole {
  const role = (raw ?? 'ceo').trim().toLowerCase()
  if (!(CANONICAL_ROLES as readonly string[]).includes(role)) {
    throw new Error(`ADMIN_ROLE must be one of: ${CANONICAL_ROLES.join(', ')} (got '${raw}').`)
  }
  return role as CanonicalRole
}

export function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

export interface CreateAdminOptions {
  email: string
  name?: string | null
  role?: CanonicalRole
  /** Explicit password. Omit to generate one on create. */
  password?: string | null
  /** Overwrite an EXISTING user's password (requires `password`). */
  forcePasswordReset?: boolean
  /** Skip the forced first-login password change. */
  skipForceReset?: boolean
}

export interface CreateAdminResult {
  userId: string
  email: string
  role: CanonicalRole
  alreadyExisted: boolean
  roleAction: 'granted' | 'already_present' | 'converted_from_legacy'
  passwordAction: 'created' | 'reset' | 'unchanged'
  /** Set only when this run GENERATED a password — shown once, never stored. */
  generatedPassword: string | null
  /** True when a recovery reset cleared a lockout or deactivation. */
  clearedLockout: boolean
}

export async function createAdminAccount(opts: CreateAdminOptions): Promise<CreateAdminResult> {
  const email = normaliseEmail(opts.email)
  const role = opts.role ?? 'ceo'
  const skipForceReset = opts.skipForceReset ?? false
  const envPassword = (opts.password ?? '').trim()

  const existing = await db.user.findUnique({ where: { email } })

  // Decide whether we set a password this run, and what it is.
  let passwordToSet: string | null = null
  let generatedPassword: string | null = null
  let passwordAction: CreateAdminResult['passwordAction']

  if (!existing) {
    // Bootstrap: must produce a working login.
    if (envPassword) {
      assertUsablePassword(envPassword)
      passwordToSet = envPassword
    } else {
      passwordToSet = generateStrongPassword()
      generatedPassword = passwordToSet
    }
    passwordAction = 'created'
  } else if (opts.forcePasswordReset) {
    // Explicit recovery: overwrite the existing password.
    if (!envPassword) {
      throw new Error(
        'ADMIN_FORCE_PASSWORD_RESET is set but ADMIN_PASSWORD is empty — nothing to reset to.',
      )
    }
    assertUsablePassword(envPassword)
    passwordToSet = envPassword
    passwordAction = 'reset'
  } else {
    // Existing user, no explicit reset asked for: never touch the password.
    passwordAction = 'unchanged'
  }

  let user
  let clearedLockout = false

  if (!existing) {
    const passwordHash = await bcrypt.hash(passwordToSet!, BCRYPT_COST)
    user = await db.user.create({
      data: {
        id: createId(),
        email,
        name: opts.name?.trim() || null,
        passwordHash,
        // Admin-created accounts skip the email round-trip, exactly as the
        // Settings → Users flow does.
        emailVerifiedAt: new Date(),
        mustResetPassword: !skipForceReset,
      },
    })
    await db.auditLogEntry.create({
      data: {
        id: createId(),
        actorId: null,
        action: 'auth.user_created',
        targetType: 'User',
        targetId: user.id,
        requestId: null,
        after: { email, role, by: 'prisma/create-admin' },
      },
    })
  } else if (passwordAction === 'reset') {
    clearedLockout = existing.lockedUntil !== null || existing.deactivatedAt !== null
    const passwordHash = await bcrypt.hash(passwordToSet!, BCRYPT_COST)
    user = await db.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        emailVerifiedAt: existing.emailVerifiedAt ?? new Date(),
        mustResetPassword: !skipForceReset,
        // Recovery clears any lock/deactivation so the admin can get back in.
        failedSignInAttempts: 0,
        lockedUntil: null,
        deactivatedAt: null,
      },
    })
    await db.auditLogEntry.create({
      data: {
        id: createId(),
        actorId: null,
        action: 'auth.password_reset_by_admin',
        targetType: 'User',
        targetId: existing.id,
        requestId: null,
        after: { email, clearedLockout, by: 'prisma/create-admin' },
      },
    })
  } else {
    // Untouched — just re-read the row so the role logic has the id.
    user = existing
  }

  // Grant the role idempotently. A legacy `super_admin` row is converted in
  // place rather than added alongside `ceo`: the @@unique([userId, role])
  // constraint would otherwise leave the user holding both (same reasoning as
  // seed-super-admin.ts).
  let roleAction: CreateAdminResult['roleAction']
  const legacy =
    role === 'ceo'
      ? await db.roleAssignment.findUnique({
          where: { userId_role: { userId: user.id, role: 'super_admin' } },
        })
      : null

  if (legacy) {
    await db.roleAssignment.update({ where: { id: legacy.id }, data: { role: 'ceo' } })
    roleAction = 'converted_from_legacy'
  } else {
    const already = await db.roleAssignment.findUnique({
      where: { userId_role: { userId: user.id, role } },
    })
    if (already) {
      roleAction = 'already_present'
    } else {
      await db.roleAssignment.create({
        data: { id: createId(), userId: user.id, role },
      })
      roleAction = 'granted'
    }
  }

  if (roleAction !== 'already_present') {
    await db.auditLogEntry.create({
      data: {
        id: createId(),
        actorId: null,
        action: 'auth.role_granted',
        targetType: 'User',
        targetId: user.id,
        requestId: null,
        after: { email, role, via: roleAction, by: 'prisma/create-admin' },
      },
    })
  }

  return {
    userId: user.id,
    email,
    role,
    alreadyExisted: existing !== null,
    roleAction,
    passwordAction,
    generatedPassword,
    clearedLockout,
  }
}

function isMain(): boolean {
  const argv1 = process.argv[1] ?? ''
  return argv1.endsWith('create-admin.ts') || argv1.endsWith('create-admin.js')
}

if (isMain()) {
  const email = (process.argv[2] ?? process.env['ADMIN_EMAIL'] ?? '').trim()
  const name = (process.argv[3] ?? process.env['ADMIN_NAME'] ?? '').trim()

  if (!email) {
    /* eslint-disable no-console */
    console.error('Usage: pnpm create-admin <email> [name]')
    console.error('Example: pnpm create-admin ops@studymind.co.uk "Ops Lead"')
    console.error('')
    console.error('Optional env: ADMIN_ROLE (default ceo), ADMIN_PASSWORD,')
    console.error('              ADMIN_FORCE_PASSWORD_RESET, ADMIN_SKIP_FORCE_RESET')
    /* eslint-enable no-console */
    process.exit(2)
  }

  createAdminAccount({
    email,
    name: name || null,
    role: parseRole(process.env['ADMIN_ROLE']),
    password: process.env['ADMIN_PASSWORD'] ?? null,
    forcePasswordReset: isTruthyEnv(process.env['ADMIN_FORCE_PASSWORD_RESET']),
    skipForceReset: isTruthyEnv(process.env['ADMIN_SKIP_FORCE_RESET']),
  })
    .then(async (r) => {
      /* eslint-disable no-console */
      console.log('---')
      console.log('admin account ready')
      console.log(`  email:    ${r.email}`)
      console.log(`  user id:  ${r.userId}`)
      console.log(`  existed:  ${r.alreadyExisted ? 'yes' : 'no (created)'}`)
      console.log(`  role:     ${r.role} (${r.roleAction})`)
      console.log(`  password: ${r.passwordAction}`)
      if (r.clearedLockout) {
        console.log('  note:     cleared a lockout / deactivation on this account')
      }
      if (r.generatedPassword) {
        console.log('')
        console.log('  ⚠ A temporary password was GENERATED (ADMIN_PASSWORD was unset).')
        console.log('    Sign in with it once, then change it (you will be forced to):')
        console.log(`    TEMPORARY PASSWORD: ${r.generatedPassword}`)
        console.log('    This is the only time it is shown. Deliver it via 1Password, not chat.')
      }
      if (r.passwordAction === 'unchanged') {
        console.log('')
        console.log('  The account already existed, so its password was left alone.')
        console.log("  To reset it: ADMIN_PASSWORD='…' ADMIN_FORCE_PASSWORD_RESET=true \\")
        console.log(`    pnpm create-admin ${r.email}`)
      }
      console.log('')
      console.log('  Next: sign in at /sign-in. Two-factor enrolment is mandatory by')
      console.log('  default, so you will be routed to /account/setup-2fa first.')
      console.log('---')
      /* eslint-enable no-console */
      await db.$disconnect()
      process.exit(0)
    })
    .catch(async (e: unknown) => {
      /* eslint-disable-next-line no-console */
      console.error('create-admin failed:', e instanceof Error ? e.message : e)
      await db.$disconnect()
      process.exit(1)
    })
}
