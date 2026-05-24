// Super-admin seed — kept deliberately simple.
//
// Rule: every deploy, the super-admin row gets the password from env and
// the password is ALWAYS overwritten. Operator owns the SUPER_ADMIN_PASSWORD
// env var; there is no idempotency guard to fight, no force-reseed flag,
// no email-link branch, no mustResetPassword gate.
//
// To rotate the password: set SUPER_ADMIN_PASSWORD to a new value in Railway
// env and redeploy. To pin it: leave the env var set.
//
// Env vars (all optional):
//   SUPER_ADMIN_EMAIL    default 'aashir@studymind.co.uk'
//   SUPER_ADMIN_NAME     default 'Aashir'
//   SUPER_ADMIN_PASSWORD default 'Wenger20'
//
// This script intentionally does not import @studymind/audit or @studymind/core
// to avoid a workspace dependency cycle (both depend on @studymind/db).

import { createId } from '@paralleldrive/cuid2'
import bcrypt from 'bcryptjs'

import { db } from '../src/index'

const BCRYPT_COST = 12

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

const PASSWORD =
  process.env['SUPER_ADMIN_PASSWORD'] ?? process.env['INITIAL_SUPER_ADMIN_PASSWORD'] ?? 'Wenger20'

export interface SeedResult {
  userId: string
  email: string
  alreadyExisted: boolean
}

export async function seedInitialSuperAdmin(): Promise<SeedResult> {
  const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_COST)
  const existing = await db.user.findUnique({ where: { email: EMAIL } })

  const user = await db.user.upsert({
    where: { email: EMAIL },
    update: {
      passwordHash,
      emailVerifiedAt: existing?.emailVerifiedAt ?? new Date(),
      mustResetPassword: false,
      failedSignInAttempts: 0,
      lockedUntil: null,
      deactivatedAt: null,
      name: existing?.name ?? NAME,
    },
    create: {
      id: createId(),
      email: EMAIL,
      name: NAME,
      passwordHash,
      emailVerifiedAt: new Date(),
      mustResetPassword: false,
    },
  })

  await db.roleAssignment.upsert({
    where: { userId_role: { userId: user.id, role: 'super_admin' } },
    update: {},
    create: {
      id: createId(),
      userId: user.id,
      role: 'super_admin',
    },
  })

  return { userId: user.id, email: EMAIL, alreadyExisted: existing !== null }
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
      console.log('super_admin seeded')
      console.log(`  email:    ${r.email}`)
      console.log(`  user id:  ${r.userId}`)
      console.log(`  existed:  ${r.alreadyExisted ? 'yes (password overwritten)' : 'no (created)'}`)
      console.log(`  password: env-controlled (${PASSWORD.length} chars)`)
      console.log('---')
      /* eslint-enable no-console */
      await db.$disconnect()
      process.exit(0)
    })
    .catch(async (e: unknown) => {
      /* eslint-disable-next-line no-console */
      console.error('super_admin seed failed:', e)
      await db.$disconnect()
      process.exit(1)
    })
}
