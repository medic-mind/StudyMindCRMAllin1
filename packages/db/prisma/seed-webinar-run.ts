// Standalone runner for the webinar seed (cohorts 2026/2027 + 2027/2028, UK
// holidays, the 8 live classes, default email settings). Idempotent — safe to
// run against an existing database, and unlike `db:seed` it does NOT touch the
// super-admin account. Use this to populate the Webinars section on an
// environment that was migrated but not seeded:
//
//   pnpm db:seed:webinar

import { db } from '../src/index'
import { seedWebinar } from './seed-webinar'

seedWebinar()
  .then(async (result) => {
    console.log(`seed: webinar cohorts + ${result.classes} classes ready`)
    await db.$disconnect()
  })
  .catch(async (err) => {
    console.error(err)
    await db.$disconnect()
    process.exit(1)
  })
