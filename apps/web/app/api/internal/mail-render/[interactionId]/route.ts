// Email reading-pane render route (ADR 0041).
//
// Returns a single email message's sanitised HTML as a standalone document with
// its OWN Content-Security-Policy, to be framed by the /mail reading pane. This
// is the correct isolation: a document loaded from an HTTP response uses THAT
// response's CSP, so we can allow the things an email needs to look like Gmail —
// remote images and inline styles — WITHOUT loosening the app's strict CSP. A
// `srcdoc` iframe (the previous approach) inherits the parent's CSP, which
// blocked external images and inline styles entirely.
//
// Safety: scripts are blocked (no script-src under `default-src 'none'`), the
// iframe is sandboxed (no allow-scripts / allow-same-origin), and the HTML is
// re-sanitised here as defence in depth. Referrer is stripped so opening the
// message never leaks the CRM URL to image hosts.

import { NextResponse } from 'next/server'

import { prepareEmailHtml } from '@studymind/core/mail'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Own CSP for the framed email document: remote images + inline styles, never
// scripts. `frame-ancestors 'self'` + the route-level X-Frame-Options SAMEORIGIN
// let /mail frame it while still blocking everyone else.
const EMAIL_FRAME_CSP = [
  "default-src 'none'",
  'img-src https: http: data: cid:',
  "style-src 'unsafe-inline'",
  'font-src https: data:',
  'media-src https: data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-popups allow-popups-to-escape-sandbox',
].join('; ')

function renderDocument(innerHtml: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<base target="_blank"><meta name="color-scheme" content="light">` +
    `<style>html,body{margin:0;padding:0;background:#fff;` +
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
    `color:#1f2933;font-size:14px;line-height:1.5;word-break:break-word}` +
    `img{max-width:100%;height:auto}a{color:#2563eb}table{max-width:100%}</style>` +
    `</head><body>${innerHtml}</body></html>`
  )
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { interactionId } = await params
  const row = await db.interaction.findFirst({
    where: {
      id: interactionId,
      deletedAt: null,
      type: { in: ['email_received', 'email_sent'] },
    },
    select: { id: true, contactId: true, payload: true },
  })
  if (!row) return new NextResponse('not found', { status: 404 })

  // Access gate — identical to the attachment route: read access to the linked
  // Contact (restricted-access enforced by contact.get); unmatched mail is
  // refused to Virtual Assistants but allowed to other triaging staff.
  if (row.contactId) {
    try {
      const caller = await createServerCaller()
      await caller.contact.get({ id: row.contactId, purpose: 'mail.render' })
    } catch {
      return new NextResponse('forbidden', { status: 403 })
    }
  } else if (me.role === 'virtual_assistant') {
    return new NextResponse('forbidden', { status: 403 })
  }

  const payload = (row.payload ?? {}) as { bodyHtml?: unknown }
  const safe = prepareEmailHtml(typeof payload.bodyHtml === 'string' ? payload.bodyHtml : null)
  const inner =
    safe ??
    '<p style="font-family:sans-serif;color:#6b7280">(no formatted content — view plain text)</p>'

  return new NextResponse(renderDocument(inner), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': EMAIL_FRAME_CSP,
      'x-frame-options': 'SAMEORIGIN',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'private, no-store',
    },
  })
}
