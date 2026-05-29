// Serves an uploaded invoice file. Authenticated callers only — middleware
// gates this route since it's not in PUBLIC_PATH_PREFIXES. Inline disposition
// so the browser previews the PDF / image; the agent can right-click → save
// to download. CLAUDE.md §20, §44.2.

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
  const row = await db.uploadedInvoice.findUnique({
    where: { id },
    select: { fileName: true, contentType: true, data: true },
  })
  if (!row) {
    return new NextResponse(null, { status: 404 })
  }
  const safeName = row.fileName.replace(/[\r\n"]/g, '_')
  return new NextResponse(row.data as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': row.contentType,
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
