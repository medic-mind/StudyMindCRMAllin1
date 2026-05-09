/* eslint-disable no-console */
// DR Step 6: Slack Events API endpoint URL is set on the Slack app config
// (api.slack.com/apps/<app-id>). Slack does not expose CRUD via the bot
// token, so this script prints the checklist. CLAUDE.md §12.

function main(): void {
  const baseUrl = process.env['WEBHOOK_BASE_URL']
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not set')
  const url = `${baseUrl.replace(/\/$/, '')}/api/webhooks/slack`

  console.log('Slack manual reconnection checklist:')
  console.log('  1. Sign in to api.slack.com/apps as an app admin.')
  console.log('  2. Open the StudyMind CRM app → Event Subscriptions.')
  console.log(`  3. Set Request URL to: ${url}`)
  console.log('  4. Wait for the green "Verified" tick (signed challenge).')
  console.log('  5. Confirm subscribed events: message.channels for the agreed list')
  console.log('     in packages/integrations/slack/src/config.ts.')
  console.log('  6. Save changes. Send a test message in a watched channel and verify')
  console.log('     the SlackEvent row lands in Postgres.')
}

main()
