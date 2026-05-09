/* eslint-disable no-console */
// DR Step 6: re-register the GoCardless webhook endpoint.
// Idempotent — checks for an existing endpoint with our URL first.
//
// Env:
//   GOCARDLESS_ACCESS_TOKEN
//   GOCARDLESS_ENV          'live' or 'sandbox' (default 'live')
//   WEBHOOK_BASE_URL
//
// CLAUDE.md §46.3 step 6.

interface GcWebhookEndpoint {
  id: string
  url: string
  active: boolean
}

async function gcRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env['GOCARDLESS_ACCESS_TOKEN']
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN is not set')
  const env = process.env['GOCARDLESS_ENV'] ?? 'live'
  const host =
    env === 'sandbox' ? 'https://api-sandbox.gocardless.com' : 'https://api.gocardless.com'

  const res = await fetch(`${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'GoCardless-Version': '2015-07-06',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`GoCardless ${method} ${path} failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

async function main(): Promise<void> {
  const baseUrl = process.env['WEBHOOK_BASE_URL']
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not set')
  const url = `${baseUrl.replace(/\/$/, '')}/api/webhooks/gocardless`

  const list = await gcRequest<{ webhook_endpoints: GcWebhookEndpoint[] }>(
    'GET',
    '/webhook_endpoints?limit=100',
  )
  const match = list.webhook_endpoints.find((w) => w.url === url)
  if (match) {
    console.log(`reusing existing GC webhook endpoint id=${match.id} url=${match.url}`)
    return
  }

  const created = await gcRequest<{ webhook_endpoints: GcWebhookEndpoint }>(
    'POST',
    '/webhook_endpoints',
    { webhook_endpoints: { url, active: true } },
  )
  console.log('created GC webhook endpoint:')
  console.log(`  id:  ${created.webhook_endpoints.id}`)
  console.log(`  url: ${created.webhook_endpoints.url}`)
  console.log('rotate / set GOCARDLESS_WEBHOOK_SECRET in Railway env')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
