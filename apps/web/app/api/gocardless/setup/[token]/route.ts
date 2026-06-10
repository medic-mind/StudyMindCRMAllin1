// Public Direct Debit setup link (ADR 0038 amendment). This is the URL we
// email to parents: durable for 14 days, unlike a raw GoCardless redirect
// flow (~30 min). Opening it mints a fresh redirect flow at click time and
// bounces the browser straight to the GoCardless hosted page. No session —
// the unguessable token scopes the request to one MandateSetupLink.

import { createId } from '@paralleldrive/cuid2'

import {
  recordSetupLinkOpen,
  resolveSetupLinkForOpen,
} from '@studymind/core/finance'
import { createHostedRedirectFlow } from '@studymind/integration-gocardless/outbound'

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
    status: ok ? 200 : 410,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params
  if (!token || token.length < 16 || token.length > 64) {
    return page(
      'This link is not valid',
      'Please use the link from your email, or contact the StudyMind team for a fresh one.',
      false,
    )
  }

  const resolved = await resolveSetupLinkForOpen(db, token)
  if (!resolved.ok) {
    if (resolved.reason === 'completed') {
      return page(
        'Your Direct Debit is already set up',
        'Nothing more to do — this Direct Debit has already been confirmed. You can close this page.',
        true,
      )
    }
    return page(
      'This link has expired',
      'For security, Direct Debit setup links stop working after a while. Please reply to the email you received, or contact the StudyMind team, and we will send you a fresh one — nothing has been charged.',
      false,
    )
  }

  const link = resolved.link
  const appUrl = (process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  )

  try {
    // Fresh GoCardless flow per click — they expire in ~30 minutes, so the
    // durable token mints one just in time. The per-open session key keeps
    // a double-click idempotent-ish while never reusing a stale flow.
    const flow = await createHostedRedirectFlow(db, {
      familyId: link.familyId,
      billingContactId: link.contactId,
      redirectUrl: `${appUrl}/api/gocardless/redirect-flow/complete`,
      ...(link.description ? { description: link.description } : {}),
      sessionKey: `setup:${link.id}:${Date.now()}`,
      setupLinkId: link.id,
      actorId: link.createdById,
      requestId: createId(),
    })

    if (flow.status !== 'succeeded' || !flow.redirectUrl) {
      return page(
        'We could not start the setup',
        'Something went wrong on our side. Please try the link again in a few minutes, or contact the StudyMind team — nothing has been charged.',
        false,
      )
    }

    await recordSetupLinkOpen(db, link.id)

    return Response.redirect(flow.redirectUrl, 302)
  } catch {
    return page(
      'We could not start the setup',
      'Something went wrong on our side. Please try the link again in a few minutes, or contact the StudyMind team — nothing has been charged.',
      false,
    )
  }
}
