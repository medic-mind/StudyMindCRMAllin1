#!/usr/bin/env tsx
// Force-reset any user's password to a known value, bypassing the seed's
// idempotency guard entirely.
//
// Usage (from project root or via railway shell):
//   pnpm db:reset-password aashir@studymind.co.uk
//   pnpm db:reset-password aashir@studymind.co.uk MyNewPassword123
//
// Default password is 'Wenger20' (matches the seed default). Use this when
// the seed has run but you can't sign in — typically because the password
// was set under different env config on an earlier deploy and the seed
// won't overwrite a non-null passwordHash.
//
// Side effects on the target user:
//   - passwordHash = bcrypt(<password>, 12)
//   - emailVerifiedAt = now (so the email-verify gate passes)
//   - mustResetPassword = false (so you don't get bounced on sign-in)
//   - failedSignInAttempts = 0, lockedUntil = null (clears any lockout)
//   - deactivatedAt = null (un-deactivates if previously deactivated)
//
// Also writes an AuditLogEntry with action='auth.password_force_reset' so
// the operation is traceable.
//
// Does NOT change role assignments. If the user has no super_admin role and
// you need to add one, run `pnpm db:seed:super-admin` after this.

import { createId } from '@paralleldrive/cuid2'
import bcrypt from 'bcryptjs'

import { db } from '../src/index'

const BCRYPT_COST = 12

async function main(): Promise<void> {
  const email = process.argv[2]?.trim().toLowerCase()
  const password = process.argv[3] ?? 'Wenger20'

  if (!email) {
    /* eslint-disable no-console */
    console.error('Usage: pnpm db:reset-password <email> [password]')
    console.error('Example: pnpm db:reset-password aashir@studymind.co.uk')
    /* eslint-enable no-console */
    process.exit(2)
  }

  const user = await db.user.findUnique({ where: { email } })
  if (!user) {
    /* eslint-disable-next-line no-console */
    console.error(
      `No user with email '${email}'. Run \`pnpm db:seed:super-admin\` first to create the account, then re-run this.`,
    )
    process.exit(1)
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST)

  await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
        mustResetPassword: false,
        failedSignInAttempts: 0,
        lockedUntil: null,
        deactivatedAt: null,
      },
    }),
    db.auditLogEntry.create({
      data: {
        id: createId(),
        actorId: null,
        action: 'auth.password_force_reset',
        targetType: 'User',
        targetId: user.id,
        requestId: null,
        after: { email, by: 'scripts/reset-password' },
      },
    }),
  ])

  /* eslint-disable no-console */
  console.log('---')
  console.log('Password reset OK')
  console.log(`  user:     ${email} (${user.id})`)
  console.log(`  password: ${password}`)
  console.log(`  next:     sign in at /sign-in then rotate via /account/change-password`)
  console.log('---')
  /* eslint-enable no-console */
}

main()
  .then(async () => {
    await db.$disconnect()
    process.exit(0)
  })
  .catch(async (e: unknown) => {
    /* eslint-disable-next-line no-console */
    console.error(e)
    await db.$disconnect()
    process.exit(1)
  })
