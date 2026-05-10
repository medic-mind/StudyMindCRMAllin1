// Idempotent seed for the StudyMind CRM dev environment.
// See CLAUDE.md Section 22 for the dev user contract.

import { db } from '../src/index'
import { seedInitialSuperAdmin } from './seed-super-admin'

async function main(): Promise<void> {
  // Seed the initial super_admin (Aashir by default). Idempotent.
  const result = await seedInitialSuperAdmin()
  /* eslint-disable no-console */
  console.log(
    `seed: super_admin ${result.email} ` +
      (result.status === 'password-set'
        ? '(password set from env)'
        : result.status === 'needs-link'
          ? '(invite link below)'
          : '(already seeded)'),
  )
  if (result.inviteUrl) {
    console.log(`seed: invite ${result.inviteUrl}`)
  }
  /* eslint-enable no-console */
}

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
