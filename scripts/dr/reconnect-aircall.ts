/* eslint-disable no-console */
// DR Step 6: re-enable any disabled Aircall webhooks. Aircall disables a
// webhook after 10 consecutive failures (CLAUDE.md §10). Re-uses the
// existing aircall client.enableWebhook from Slice 5.
//
// Env: AIRCALL_API_ID, AIRCALL_API_TOKEN.
//
// CLAUDE.md §46.3 step 6.

import { createClient } from '@studymind/integration-aircall/client'

async function main(): Promise<void> {
  const client = createClient()
  const all = await client.listWebhooks()
  console.log(`found ${all.length} Aircall webhook(s)`)
  let enabled = 0
  for (const w of all) {
    if (w.disabled || w.active === false) {
      const updated = await client.enableWebhook(w.webhook_id)
      console.log(`re-enabled webhook id=${w.webhook_id} url=${updated.url}`)
      enabled += 1
    } else {
      console.log(`already-active webhook id=${w.webhook_id} url=${w.url}`)
    }
  }
  console.log(`enabled ${enabled} webhook(s)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
