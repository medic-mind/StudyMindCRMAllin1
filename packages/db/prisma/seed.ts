// Idempotent seed for the StudyMind CRM dev environment.
// See CLAUDE.md Section 22 for the dev user contract.
// This is a placeholder; real implementation lands in a follow-up PR.

import { db } from '../src/index.js'

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('seed: placeholder — no rows written yet')
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
