// Serves an info pack / brochure PDF from the document library. Authenticated
// callers only — middleware gates this route since it's not in
// PUBLIC_PATH_PREFIXES. Inline (not attachment) disposition so the browser
// previews the pack in a new tab before the agent attaches it.

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
  const row = await db.infoPackDocument.findUnique({
    where: { id },
    select: {
      fileName: true,
      contentType: true,
      data: true,
    },
  })
  if (!row || !row.data) {
    return new NextResponse(null, { status: 404 })
  }
  const safeName = (row.fileName ?? 'document.pdf').replace(/[\r\n"]/g, '_')
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
