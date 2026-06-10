// Public completion endpoint for the GoCardless hosted mandate flow
// (ADR 0038). GoCardless sends the customer's browser here after they confirm
// their bank details; we complete the flow server-side (the moment the
// customer + mandate are actually created), mirror both, and show a plain
// confirmation page. No session — the customer is a parent, not a staff user;
// the unguessable redirect_flow_id scopes the request to one MandateIntent.

import { createId } from '@paralleldrive/cuid2'

import { completeHostedRedirectFlow } from '@studymind/integration-gocardless/outbound'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function page(title: string, body: string, ok: boolean): Response {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} — StudyMind</title>
    <style>
      body { font-family: system-ui, -apple-system, sans-serif; background: #f8fafc; margin: 0;
             display: flex; min-height: 100vh; align-items: center; justify-content: center; }
      main { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 2.5rem;
             max-width: 26rem; text-align: center; }
      h1 { font-size: 1.25rem; color: ${ok ? '#0f172a' : '#b91c1c'}; }
      p { color: #475569; line-height: 1.5; }
    </style>
  </head>
  <body><main><h1>${title}</h1><p>${body}</p></main></body>
</html>`
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const redirectFlowId = url.searchParams.get('redirect_flow_id')

  if (!redirectFlowId) {
    return page(
      'Something went wrong',
      'This link is missing its reference. Please use the link you were sent, or contact the StudyMind team.',
      false,
    )
  }

  try {
    const result = await completeHostedRedirectFlow(db, {
      redirectFlowId,
      requestId: createId(),
    })
    if (!result.ok) {
      return page(
        'We could not confirm your Direct Debit',
        'The setup link may have expired. Please ask the StudyMind team to send you a fresh one — nothing has been charged.',
        false,
      )
    }
    return page(
      'Direct Debit set up',
      'Thank you — your Direct Debit is confirmed. You will receive notice from GoCardless before any payment is collected. You can close this page.',
      true,
    )
  } catch {
    return page(
      'We could not confirm your Direct Debit',
      'Something went wrong on our side. Please try the link again in a few minutes, or contact the StudyMind team — nothing has been charged.',
      false,
    )
  }
}
