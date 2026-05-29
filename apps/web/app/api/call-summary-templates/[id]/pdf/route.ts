// Serves the PDF attached to a call summary template. Authenticated callers
// only — middleware gates this route since it's not in PUBLIC_PATH_PREFIXES.
// Inline (not attachment) disposition so the browser previews the script in
// a new tab while the caller is mid-call.

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
  const row = await db.callSummaryTemplate.findUnique({
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
  const safeName = (row.pdfFileName ?? 'template.pdf').replace(/[\r\n"]/g, '_')
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
