// Idempotent seed for the StudyMind CRM dev environment.
// See CLAUDE.md Section 22 for the dev user contract.

import { db } from '../src/index'
import { seedInitialSuperAdmin } from './seed-super-admin'
import { seedWebinar } from './seed-webinar'

async function main(): Promise<void> {
  const result = await seedInitialSuperAdmin()
  /* eslint-disable-next-line no-console */
  console.log(
    `seed: ceo ${result.email} ` +
      (result.alreadyExisted ? '(password overwritten)' : '(created)'),
  )
  const webinar = await seedWebinar()
  /* eslint-disable-next-line no-console */
  console.log(`seed: webinar cohorts + ${webinar.classes} classes ready`)
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
