/* eslint-disable no-console */
// DR Step 6: re-register the Stripe webhook endpoint pointing at the
// recovery URL. Idempotent — checks for an existing endpoint with our URL
// before creating a new one.
//
// Env:
//   STRIPE_API_KEY        live or restricted key with `webhook_endpoints`
//                         scope
//   WEBHOOK_BASE_URL      e.g. https://crm-recovery.up.railway.app
//
// Output: prints the endpoint id and the signing secret. Store the secret
// in Railway env (STRIPE_WEBHOOK_SECRET) before any traffic flows.
//
// CLAUDE.md §46.3 step 6.

import Stripe from 'stripe'

const ENABLED_EVENTS: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'checkout.session.completed',
]

async function main(): Promise<void> {
  const apiKey = process.env['STRIPE_API_KEY']
  const baseUrl = process.env['WEBHOOK_BASE_URL']
  if (!apiKey) throw new Error('STRIPE_API_KEY is not set')
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not set')
  const url = `${baseUrl.replace(/\/$/, '')}/api/webhooks/stripe`

  const stripe = new Stripe(apiKey, { apiVersion: '2024-09-30.acacia' })

  // Find existing endpoint with our URL.
  const existing = await stripe.webhookEndpoints.list({ limit: 100 })
  const match = existing.data.find((e) => e.url === url)

  if (match) {
    console.log(`reusing existing webhook endpoint id=${match.id} url=${match.url}`)
    console.log('NOTE: signing secret cannot be re-fetched. Rotate via dashboard if lost.')
    return
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: ENABLED_EVENTS,
    description: 'StudyMind CRM (DR-recovered)',
  })

  console.log('created webhook endpoint:')
  console.log(`  id:     ${created.id}`)
  console.log(`  url:    ${created.url}`)
  console.log(`  secret: ${created.secret}`)
  console.log('store the secret in Railway env STRIPE_WEBHOOK_SECRET')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
