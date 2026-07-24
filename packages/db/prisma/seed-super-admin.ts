// CEO bootstrap seed. (Filename retained for migration stability; the role
// granted is `ceo` per ADR 0014.)
//
// SECURITY (2026-07): this seed used to ship a hard-coded fallback password
// ('Wenger20') and OVERWRITE the CEO password on every deploy. That was a
// default-credential risk (a fresh deploy with no env set = a known password)
// AND it silently clobbered whatever password the CEO had set in-app. Both are
// removed. The seed is now non-destructive:
//
//   • FIRST bootstrap (row does not exist): creates the CEO. The password is
//     taken from SUPER_ADMIN_PASSWORD if set (must be >= 12 chars), otherwise a
//     strong random password is GENERATED and printed once to the deploy log.
//     `mustResetPassword` is TRUE, so the operator is forced to change it on
//     first login (unless SUPER_ADMIN_SKIP_FORCE_RESET=true).
//
//   • EXISTING row (every later deploy): the password is LEFT ALONE. The seed
//     only ensures the `ceo` role assignment exists. It never re-hashes or
//     resets the password, so a redeploy can't reset a CEO's chosen password.
//
//   • RECOVERY (locked out, no other admin): set SUPER_ADMIN_PASSWORD and
//     SUPER_ADMIN_FORCE_PASSWORD_RESET=true, then redeploy. Only then is the
//     existing password overwritten (and mustResetPassword set), and the lock
//     counters + deactivation cleared. Unset the flag afterwards.
//
// Env vars (all optional):
//   SUPER_ADMIN_EMAIL              default 'aashir@studymind.co.uk'
//   SUPER_ADMIN_NAME              default 'Aashir'
//   SUPER_ADMIN_PASSWORD         used on create; on existing rows only with the force flag
//   SUPER_ADMIN_FORCE_PASSWORD_RESET  'true' to reset an EXISTING CEO password (recovery)
//   SUPER_ADMIN_SKIP_FORCE_RESET      'true' to NOT force a first-login change on create
//
// This script intentionally does not import @studymind/audit or @studymind/core
// to avoid a workspace dependency cycle (both depend on @studymind/db), so the
// password generator + strength check are inlined here.

import { randomInt } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import bcrypt from 'bcryptjs'

import { db } from '../src/index'

const BCRYPT_COST = 12
const MIN_PASSWORD_LENGTH = 12

const EMAIL = (
  process.env['SUPER_ADMIN_EMAIL'] ??
  process.env['INITIAL_SUPER_ADMIN_EMAIL'] ??
  'aashir@studymind.co.uk'
)
  .trim()
  .toLowerCase()

const NAME = (
  process.env['SUPER_ADMIN_NAME'] ?? process.env['INITIAL_SUPER_ADMIN_NAME'] ?? 'Aashir'
).trim()

const ENV_PASSWORD = (
  process.env['SUPER_ADMIN_PASSWORD'] ??
  process.env['INITIAL_SUPER_ADMIN_PASSWORD'] ??
  ''
).trim()

function isTruthyEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

const FORCE_PASSWORD_RESET = isTruthyEnv(process.env['SUPER_ADMIN_FORCE_PASSWORD_RESET'])
const SKIP_FORCE_RESET = isTruthyEnv(process.env['SUPER_ADMIN_SKIP_FORCE_RESET'])

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
function assertUsablePassword(pw: string): void {
  if (pw.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `SUPER_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters (got ${pw.length}).`,
    )
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((re) => re.test(pw)).length
  if (classes < 3) {
    throw new Error(
      'SUPER_ADMIN_PASSWORD must use at least 3 of: lowercase, uppercase, digit, symbol.',
    )
  }
}

export interface SeedResult {
  userId: string
  email: string
  alreadyExisted: boolean
  /** Set only when the seed GENERATED a password (first bootstrap, no env). */
  generatedPassword: string | null
  passwordAction: 'created' | 'reset' | 'unchanged'
}

export async function seedInitialSuperAdmin(): Promise<SeedResult> {
  const existing = await db.user.findUnique({ where: { email: EMAIL } })

  // Decide whether we set a password this run, and what it is.
  let passwordToSet: string | null = null
  let generatedPassword: string | null = null
  let passwordAction: SeedResult['passwordAction']

  if (!existing) {
    // Bootstrap: must produce a working login.
    if (ENV_PASSWORD) {
      assertUsablePassword(ENV_PASSWORD)
      passwordToSet = ENV_PASSWORD
    } else {
      passwordToSet = generateStrongPassword()
      generatedPassword = passwordToSet
    }
    passwordAction = 'created'
  } else if (FORCE_PASSWORD_RESET) {
    // Explicit recovery: overwrite the existing password.
    if (!ENV_PASSWORD) {
      throw new Error(
        'SUPER_ADMIN_FORCE_PASSWORD_RESET is set but SUPER_ADMIN_PASSWORD is empty — nothing to reset to.',
      )
    }
    assertUsablePassword(ENV_PASSWORD)
    passwordToSet = ENV_PASSWORD
    passwordAction = 'reset'
  } else {
    // Normal redeploy: never touch the password.
    passwordAction = 'unchanged'
  }

  let user
  if (!existing) {
    const passwordHash = await bcrypt.hash(passwordToSet!, BCRYPT_COST)
    user = await db.user.create({
      data: {
        id: createId(),
        email: EMAIL,
        name: NAME,
        passwordHash,
        emailVerifiedAt: new Date(),
        // Force a first-login change unless the operator opts out.
        mustResetPassword: !SKIP_FORCE_RESET,
      },
    })
  } else if (passwordAction === 'reset') {
    const passwordHash = await bcrypt.hash(passwordToSet!, BCRYPT_COST)
    user = await db.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        mustResetPassword: !SKIP_FORCE_RESET,
        // Recovery clears any lock/deactivation so the operator can get back in.
        failedSignInAttempts: 0,
        lockedUntil: null,
        deactivatedAt: null,
      },
    })
  } else {
    // Untouched — just re-read the row so downstream role logic has the id.
    user = existing
  }

  // Convert any legacy super_admin row in place so the user does not end up
  // with both `super_admin` and `ceo` (the @@unique([userId, role])
  // constraint would refuse the second insert and the bulk migration in
  // 20260524120100_migrate_sales_roles would race with this script).
  const legacy = await db.roleAssignment.findUnique({
    where: { userId_role: { userId: user.id, role: 'super_admin' } },
  })
  if (legacy) {
    await db.roleAssignment.update({
      where: { id: legacy.id },
      data: { role: 'ceo' },
    })
  } else {
    await db.roleAssignment.upsert({
      where: { userId_role: { userId: user.id, role: 'ceo' } },
      update: {},
      create: {
        id: createId(),
        userId: user.id,
        role: 'ceo',
      },
    })
  }

  return {
    userId: user.id,
    email: EMAIL,
    alreadyExisted: existing !== null,
    generatedPassword,
    passwordAction,
  }
}

function isMain(): boolean {
  const argv1 = process.argv[1] ?? ''
  return argv1.endsWith('seed-super-admin.ts') || argv1.endsWith('seed-super-admin.js')
}

if (isMain()) {
  seedInitialSuperAdmin()
    .then(async (r) => {
      /* eslint-disable no-console */
      console.log('---')
      console.log('ceo seeded')
      console.log(`  email:    ${r.email}`)
      console.log(`  user id:  ${r.userId}`)
      console.log(`  existed:  ${r.alreadyExisted ? 'yes' : 'no (created)'}`)
      console.log(`  password: ${r.passwordAction}`)
      if (r.generatedPassword) {
        console.log('')
        console.log('  ⚠ A temporary CEO password was GENERATED (SUPER_ADMIN_PASSWORD was unset).')
        console.log('    Sign in once with it, then change it immediately (you will be forced to):')
        console.log(`    TEMPORARY PASSWORD: ${r.generatedPassword}`)
        console.log('    This is the only time it is shown. Set SUPER_ADMIN_PASSWORD to pin your own.')
      }
      console.log('---')
      /* eslint-enable no-console */
      await db.$disconnect()
      process.exit(0)
    })
    .catch(async (e: unknown) => {
      /* eslint-disable-next-line no-console */
      console.error('ceo seed failed:', e)
      await db.$disconnect()
      process.exit(1)
    })
}
