#!/usr/bin/env tsx
// Trengo webhook setup helper. CLAUDE.md §11.
//
// What it does (interactive):
//   1. Prompt for the Trengo workspace URL + admin token.
//   2. List/create webhook endpoints via Trengo's API. If the API path is
//      not available for this workspace, fall back to a printed checklist
//      that points the operator at the manual UI flow.
//   3. Generate a fresh TRENGO_WEBHOOK_SECRET (32 random hex bytes) and
//      print it for the operator to set in Railway.
//   4. Verify the public webhook endpoint accepts requests by sending a
//      HEAD with a deliberately-invalid signature; we expect 400 because
//      verification rejects mismatched signatures (proving the verifier
//      is wired up).
//
// Usage:
//   pnpm setup:trengo
//
// The script never logs the admin token or the webhook secret to disk. Both
// are printed once to stdout for the operator to paste into 1Password and
// Railway.

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { randomBytes, createHmac } from 'node:crypto'

interface Options {
  workspaceUrl: string
  adminToken: string
  webhookUrl: string
}

async function prompt(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    const ans = await rl.question(question + (fallback ? ` [${fallback}] ` : ' '))
    return ans.trim() || (fallback ?? '')
  } finally {
    rl.close()
  }
}

async function readOptions(): Promise<Options> {
  const workspaceUrl = await prompt(
    'Trengo workspace URL (e.g. https://app.trengo.com):',
    'https://app.trengo.com',
  )
  const adminToken = await prompt('Trengo admin API token:')
  if (!adminToken) {
    throw new Error('admin token is required')
  }
  const webhookUrl = await prompt(
    'Public webhook URL (e.g. https://crm.studymind.co.uk/api/webhooks/trengo):',
  )
  if (!webhookUrl) {
    throw new Error('public webhook URL is required')
  }
  return { workspaceUrl, adminToken, webhookUrl }
}

async function tryCreateWebhook(opts: Options): Promise<'created' | 'manual'> {
  const url = `${opts.workspaceUrl.replace(/\/$/, '')}/api/v2/webhooks`
  const body = {
    url: opts.webhookUrl,
    name: 'StudyMind CRM',
    events: [
      'message.created',
      'ticket.created',
      'ticket.assigned',
      'ticket.closed',
      'ticket.reopened',
      'label.added',
      'label.removed',
    ],
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.adminToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (res.ok) {
    console.log(`✓ Webhook created on Trengo (status ${res.status}).`)
    return 'created'
  }
  if (res.status === 404 || res.status === 405) {
    return 'manual'
  }
  const text = await res.text().catch(() => '')
  console.warn(`Trengo API returned ${res.status}: ${text}`)
  console.warn('Falling back to manual UI checklist.')
  return 'manual'
}

function printManualChecklist(opts: Options): void {
  console.log()
  console.log('Manual setup steps (Trengo UI):')
  console.log(`  1. Open ${opts.workspaceUrl}/admin/webhooks`)
  console.log('  2. Create a new webhook with:')
  console.log(`       Name: StudyMind CRM`)
  console.log(`       URL : ${opts.webhookUrl}`)
  console.log(
    '       Events: message.created, ticket.created, ticket.assigned, ticket.closed,',
  )
  console.log(
    '               ticket.reopened, label.added, label.removed',
  )
  console.log('  3. Set the signing secret to the value printed below.')
  console.log('  4. Save.')
}

async function verifyEndpoint(opts: Options): Promise<void> {
  // Send a request with a deliberately-invalid signature. The endpoint
  // must reject with 400 "invalid signature", proving the verifier is
  // wired up and reachable from the public internet.
  const fakeBody = JSON.stringify({ probe: 'setup-trengo' })
  const fakeSig = createHmac('sha256', 'wrong-secret').update(fakeBody).digest('hex')
  const res = await fetch(opts.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-trengo-signature': fakeSig },
    body: fakeBody,
  })
  if (res.status === 400) {
    console.log('✓ Endpoint is reachable and rejects invalid signatures (expected 400).')
    return
  }
  console.warn(
    `Endpoint responded with ${res.status}; expected 400 for an invalid signature. Check that TRENGO_WEBHOOK_SECRET is set in the target environment and the route is deployed.`,
  )
}

async function main(): Promise<void> {
  const opts = await readOptions()

  console.log()
  const result = await tryCreateWebhook(opts)
  if (result === 'manual') printManualChecklist(opts)

  const secret = randomBytes(32).toString('hex')
  console.log()
  console.log('Generated TRENGO_WEBHOOK_SECRET (set in Railway env, mirror to 1Password):')
  console.log()
  console.log(`  ${secret}`)
  console.log()

  console.log('Verifying public endpoint...')
  await verifyEndpoint(opts)

  console.log()
  console.log('Done. After setting TRENGO_WEBHOOK_SECRET in Railway and Trengo, ')
  console.log('run a real Trengo webhook to confirm end-to-end delivery.')
}

main().catch((err) => {
  console.error('setup-trengo failed:', err)
  process.exit(1)
})
