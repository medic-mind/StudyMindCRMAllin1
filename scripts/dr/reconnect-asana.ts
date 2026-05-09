/* eslint-disable no-console */
// DR Step 6: re-create Asana webhooks for the configured project allowlist.
// CLAUDE.md §13. Idempotent — checks for existing webhooks at our URL.
//
// Asana webhooks require an X-Hook-Secret handshake. The CRM's webhook
// route handles that automatically; we just create the webhook here.
//
// Env:
//   ASANA_PERSONAL_ACCESS_TOKEN
//   ASANA_PROJECT_ALLOWLIST   comma-separated GIDs
//   WEBHOOK_BASE_URL

interface AsanaWebhook {
  gid: string
  resource: { gid: string }
  target: string
}

async function asanaRequest<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = process.env['ASANA_PERSONAL_ACCESS_TOKEN']
  if (!token) throw new Error('ASANA_PERSONAL_ACCESS_TOKEN is not set')

  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`Asana ${method} ${path} failed: ${res.status} ${await res.text()}`)
  }
  return (await res.json()) as T
}

async function main(): Promise<void> {
  const baseUrl = process.env['WEBHOOK_BASE_URL']
  if (!baseUrl) throw new Error('WEBHOOK_BASE_URL is not set')
  const target = `${baseUrl.replace(/\/$/, '')}/api/webhooks/asana`

  const allowlist = (process.env['ASANA_PROJECT_ALLOWLIST'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (allowlist.length === 0) {
    throw new Error('ASANA_PROJECT_ALLOWLIST is empty')
  }

  const existing = await asanaRequest<{ data: AsanaWebhook[] }>(
    'GET',
    `/webhooks?workspace=${process.env['ASANA_WORKSPACE_GID'] ?? ''}&limit=100`,
  )

  for (const projectGid of allowlist) {
    const match = existing.data.find(
      (w) => w.resource.gid === projectGid && w.target === target,
    )
    if (match) {
      console.log(`reusing webhook for project=${projectGid} gid=${match.gid}`)
      continue
    }
    const created = await asanaRequest<{ data: AsanaWebhook }>('POST', '/webhooks', {
      data: { resource: projectGid, target },
    })
    console.log(`created webhook for project=${projectGid} gid=${created.data.gid}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
