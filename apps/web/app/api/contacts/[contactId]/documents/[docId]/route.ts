// Serves a contact document. Authenticated callers only — the middleware
// gates this route since it's not in PUBLIC_PATH_PREFIXES. The contactId in
// the URL must match the document's contactId so a forged path can't pull
// someone else's file. CLAUDE.md §20, §44.2.

import { NextResponse } from 'next/server'

import { getContactDocumentBytes } from '@studymind/core/contact/documents'

import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ contactId: string; docId: string }> },
): Promise<NextResponse> {
  const { contactId, docId } = await params
  const doc = await getContactDocumentBytes(db, docId)
  if (!doc || doc.contactId !== contactId) {
    return new NextResponse(null, { status: 404 })
  }
  const safeName = doc.fileName.replace(/[\r\n"]/g, '_')
  return new NextResponse(doc.data as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': doc.contentType,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
