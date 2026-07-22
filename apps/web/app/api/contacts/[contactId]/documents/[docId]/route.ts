// Serves a contact document. Defence-in-depth like the sibling attachment
// routes (audio / mail-attachment / trengo-attachment): the middleware gates
// authentication, but we ALSO verify the caller in-handler, run the
// `contact.get` access gate (which enforces restricted-access), and write an
// audit row — a document (e.g. an EHCP extract) must never stream with no
// access check and no audit trail. CLAUDE.md §20, §21, §44.2.

import { NextResponse } from 'next/server'

import { writeAuditLogEntry } from '@studymind/audit'

import { getContactDocumentBytes } from '@studymind/core/contact/documents'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ contactId: string; docId: string }> },
): Promise<NextResponse> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { contactId, docId } = await params
  const doc = await getContactDocumentBytes(db, docId)
  if (!doc || doc.contactId !== contactId) {
    return new NextResponse(null, { status: 404 })
  }

  // Access gate: the caller must have read access to the linked Contact.
  // Delegates to `contact.get`, which enforces the restricted-access attribute
  // check. A forbidden caller gets 403, never the bytes.
  try {
    const caller = await createServerCaller()
    await caller.contact.get({ id: contactId, purpose: 'document.download' })
  } catch {
    return new NextResponse('forbidden', { status: 403 })
  }

  await writeAuditLogEntry(db, {
    actorId: me.id,
    action: 'contact.document_downloaded',
    target: { type: 'Contact', id: contactId },
    after: { docId, fileName: doc.fileName },
    purpose: 'document.download',
  })

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
