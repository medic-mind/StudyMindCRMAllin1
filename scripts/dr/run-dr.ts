/* eslint-disable no-console */
// DR orchestrator. Runs each reconnect script in order, prompting the
// operator between phases. Each script is also invokable standalone.
//
// CLAUDE.md §46.3.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const STEPS: Array<{ id: string; script: string; description: string }> = [
  { id: 'stripe', script: 'reconnect-stripe.ts', description: 'Stripe — recreate webhook endpoint' },
  { id: 'gocardless', script: 'reconnect-gocardless.ts', description: 'GoCardless — recreate webhook endpoint' },
  { id: 'aircall', script: 'reconnect-aircall.ts', description: 'Aircall — re-enable disabled webhooks' },
  { id: 'trengo', script: 'reconnect-trengo.ts', description: 'Trengo — manual UI checklist' },
  { id: 'slack', script: 'reconnect-slack.ts', description: 'Slack — manual app config checklist' },
  { id: 'asana', script: 'reconnect-asana.ts', description: 'Asana — recreate per-project webhooks' },
  { id: 'gmail', script: 'reconnect-gmail.ts', description: 'Gmail — renew users.watch for every mailbox' },
  { id: 'booking', script: 'reconnect-booking.ts', description: 'Booking — verify pull connectivity' },
]

function runScript(scriptName: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['tsx', `scripts/dr/${scriptName}`], {
      stdio: 'inherit',
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

async function main(): Promise<void> {
  const rl = createInterface({ input, output })
  console.log('=== StudyMind CRM DR orchestrator ===')
  console.log('CLAUDE.md §46. Run each step; abort with Ctrl-C.')
  console.log()

  for (const step of STEPS) {
    const ans = (await rl.question(`> Run ${step.id} (${step.description})? [y/N/skip] `)).trim().toLowerCase()
    if (ans === 'skip' || ans === 's') {
      console.log(`  skipped ${step.id}`)
      continue
    }
    if (ans !== 'y' && ans !== 'yes') {
      console.log(`  aborted at ${step.id}`)
      rl.close()
      process.exit(1)
    }
    const code = await runScript(step.script)
    if (code !== 0) {
      console.error(`step ${step.id} failed with code ${code}`)
      const cont = (await rl.question('continue anyway? [y/N] ')).trim().toLowerCase()
      if (cont !== 'y' && cont !== 'yes') {
        rl.close()
        process.exit(code)
      }
    }
    console.log()
  }

  rl.close()
  console.log('all steps complete. Now run replay-provider-events.ts with the recovery window.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
