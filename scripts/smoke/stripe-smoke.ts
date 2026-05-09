#!/usr/bin/env tsx
// Post-deploy synthetic Stripe smoke. CLAUDE.md §24.1.
//
// 1) Build a signed `invoice.payment_failed` event using
//    `stripe.webhooks.generateTestHeaderString` and a known test signing secret.
// 2) POST it to /api/webhooks/stripe.
// 3) Poll /api/internal/smoke/last-provider-event until the ProviderEvent row
//    appears (max 30 s). Exit non-zero on failure.
//
// Required env: BASE_URL, STRIPE_WEBHOOK_SECRET, SMOKE_ADMIN_TOKEN.

import { setTimeout as sleep } from 'node:timers/promises'

import Stripe from 'stripe'

const BASE_URL = required('BASE_URL')
const STRIPE_WEBHOOK_SECRET = required('STRIPE_WEBHOOK_SECRET')
const SMOKE_ADMIN_TOKEN = required('SMOKE_ADMIN_TOKEN')

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`missing env ${name}`)
    process.exit(2)
  }
  return v
}

async function main(): Promise<void> {
  const eventId = `evt_smoke_${Date.now()}`
  const payload = JSON.stringify({
    id: eventId,
    object: 'event',
    api_version: '2024-04-10',
    created: Math.floor(Date.now() / 1000),
    type: 'invoice.payment_failed',
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: `in_smoke_${Date.now()}`,
        object: 'invoice',
        status: 'open',
        attempted: true,
        amount_due: 1000,
        currency: 'gbp',
        customer: 'cus_smoke',
      },
    },
  })

  const stripe = new Stripe('sk_test_smoke', { apiVersion: '2024-04-10' })
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: STRIPE_WEBHOOK_SECRET,
  })

  console.log(`POST ${BASE_URL}/api/webhooks/stripe with eventId=${eventId}`)
  const startPost = Date.now()
  const postRes = await fetch(`${BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sig },
    body: payload,
  })
  const elapsedPost = Date.now() - startPost
  if (!postRes.ok) {
    console.error(`webhook returned ${postRes.status} after ${elapsedPost} ms`)
    process.exit(3)
  }
  if (elapsedPost > 5000) {
    console.error(`webhook took ${elapsedPost} ms — > 5 s budget`)
    process.exit(4)
  }
  console.log(`webhook 200 in ${elapsedPost} ms`)

  // Poll the smoke endpoint for the ProviderEvent row.
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const url = `${BASE_URL}/api/internal/smoke/last-provider-event?provider=stripe&eventId=${eventId}`
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${SMOKE_ADMIN_TOKEN}` },
    })
    if (!res.ok) {
      console.error(`smoke endpoint returned ${res.status}`)
      await sleep(2000)
      continue
    }
    const body = (await res.json()) as { exists: boolean; receivedAt: string | null }
    if (body.exists) {
      console.log(`ProviderEvent row landed (receivedAt=${body.receivedAt})`)
      return
    }
    await sleep(2000)
  }
  console.error('ProviderEvent row never appeared within 30 s')
  process.exit(5)
}

main().catch((err) => {
  console.error('smoke failed:', err)
  process.exit(1)
})
