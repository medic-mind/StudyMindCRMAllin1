// Invoice PDF proxy (B2B Invoices Platform). Streams the *exact* server-rendered
// PDF a client receives — byte-identical to Send / Send-reminder — so the CRM
// can preview/download it inline with no email sent.
//
// The platform API key stays server-side: the browser hits this route, the route
// fetches `GET /api/v1/invoices/:id/pdf?format=pdf` with the stored key and pipes
// the bytes back. Staff-gated (the invoice surface excludes Virtual Assistants);
// each view is audited (a financial document read, CLAUDE.md §20). NO email sent.

import { writeAuditLogEntry } from '@studymind/audit'
import {
  InvoicingApiError,
  createClientFromConfig,
} from '@studymind/integration-invoicing/client'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ceo · senior_manager · manager · sales_executive — anyone who can see or raise
// invoices. Virtual Assistants are excluded (they cannot view the invoice list).
const PDF_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

export async function GET(
  req: Request,
  { params }: { params: Promise<{ invoicingId: string }> },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new Response('unauthenticated', { status: 401 })
  if (!PDF_ROLES.has(me.role)) return new Response('forbidden', { status: 403 })

  const { invoicingId } = await params
  if (!invoicingId) return new Response('bad request', { status: 400 })

  const download = new URL(req.url).searchParams.get('download') === '1'
  const disposition = download ? 'attachment' : 'inline'

  let pdf: { bytes: ArrayBuffer; contentType: string; filename: string }
  try {
    const client = await createClientFromConfig()
    pdf = await client.getInvoicePdfBytes(invoicingId, { disposition })
  } catch (err) {
    if (err instanceof InvoicingApiError) {
      const status = err.status === 404 ? 404 : 502
      return new Response('could not fetch invoice PDF', { status })
    }
    // Unconfigured key / decrypt failure — surface as a 502 (config problem),
    // never a 500 that pages on-call.
    return new Response('invoicing not configured', { status: 502 })
  }

  // Audit the view best-effort — a failure here must not block the document.
  try {
    await writeAuditLogEntry(db, {
      actorId: me.id,
      action: 'invoicing.pdf_viewed',
      target: { type: 'InvoicingInvoice', id: invoicingId },
      after: { disposition },
    })
  } catch {
    // swallow — auditing the read is best-effort, the document is the priority
  }

  return new Response(pdf.bytes, {
    status: 200,
    headers: {
      'Content-Type': pdf.contentType || 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${pdf.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
