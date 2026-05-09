/* eslint-disable no-console */
// DR Step 6: Trengo does not expose webhook CRUD via API today. This script
// emits a checklist for the on-call to perform in the Trengo UI. CLAUDE.md
// §11.
//
// Env: WEBHOOK_BASE_URL (for the URL we need to set in Trengo).

function main(): void {
  const baseUrl = process.env['WEBHOOK_BASE_URL']
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not set')
  const url = `${baseUrl.replace(/\/$/, '')}/api/webhooks/trengo`

  console.log('Trengo manual reconnection checklist:')
  console.log('  1. Sign in to Trengo as a workspace admin.')
  console.log('  2. Navigate to Settings → Apps & integrations → Webhooks.')
  console.log(`  3. Set the inbound webhook URL to: ${url}`)
  console.log('  4. Confirm the webhook secret matches TRENGO_WEBHOOK_SECRET in Railway env.')
  console.log('  5. Subscribe to: new inbound message, new outbound message,')
  console.log('     ticket assigned, ticket closed, ticket reopened, label added/removed.')
  console.log('  6. Click "Send test event" and verify a 200 in Sentry breadcrumbs.')
  console.log()
  console.log('  Per-agent tokens (CLAUDE.md §11) survive DR — no rotation required')
  console.log('  unless the disaster compromised secrets.')
}

main()
