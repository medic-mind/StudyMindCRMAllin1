// Idempotent seed for the StudyMind CRM dev environment.
// See CLAUDE.md Section 22 for the dev user contract.

import { db } from '../src/index'
import { seedInitialSuperAdmin } from './seed-super-admin'

async function main(): Promise<void> {
  const result = await seedInitialSuperAdmin()
  /* eslint-disable-next-line no-console */
  console.log(
    `seed: ceo ${result.email} ` +
      (result.alreadyExisted ? '(password overwritten)' : '(created)'),
  )
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
