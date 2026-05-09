// Lead capture webhook (Zapier and partners). See CLAUDE.md Section 16.

import { withSentry } from '@studymind/core/observability/sentry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'lead', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  const auth = req.headers.get('authorization')
  const expected = process.env['LEAD_WEBHOOK_TOKEN']
  if (!expected || auth !== `Bearer ${expected}`) {
    return new Response('unauthorised', { status: 401 })
  }
  // TODO: parse, persist as Lead row, return 2xx.
  return Response.json({ ok: true })
}
