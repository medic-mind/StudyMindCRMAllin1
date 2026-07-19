// Serves the PDF attached to a Direct Debit recovery template (ADR 0045
// amendment) — the "letter before action" / escalation document. Authenticated
// callers only (middleware gates non-public routes). Inline disposition so a
// Manager can preview it while editing the template.

import { NextResponse } from 'next/server'

import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const me = await getCurrentUser()
  if (!me) {
    return new NextResponse(null, { status: 401 })
  }
  const { id } = await params
  const row = await db.ddRecoveryTemplate.findUnique({
    where: { id },
    select: {
      pdfFileName: true,
      pdfContentType: true,
      pdfData: true,
    },
  })
  if (!row || !row.pdfData || !row.pdfContentType) {
    return new NextResponse(null, { status: 404 })
  }
  const safeName = (row.pdfFileName ?? 'recovery-letter.pdf').replace(/[\r\n"]/g, '_')
  return new NextResponse(row.pdfData as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': row.pdfContentType,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
