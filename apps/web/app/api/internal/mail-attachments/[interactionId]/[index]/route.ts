// Email attachment download endpoint (ADR 0021 Phase 4).
//
// Streams a stored Gmail attachment back from S3. Mirrors the Trengo
// attachment route: read the email Interaction for the caller, gate on read
// access to the linked Contact (via the tRPC server caller + contact.get,
// which enforces restricted-access), look up the attachment's S3 key from the
// payload by index, and pipe the object back. We proxy through the edge rather
// than handing out a presigned URL so the audit trail stays honest.

import { NextResponse } from 'next/server'

import { getAttachment } from '@studymind/integration-gmail/s3'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface MailAttachment {
  s3Key?: string | null
  filename?: string
  mimeType?: string
  sizeBytes?: number
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ interactionId: string; index: string }> },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { interactionId, index } = await params
  const idx = Number.parseInt(index, 10)
  if (!Number.isInteger(idx) || idx < 0) {
    return new NextResponse('bad index', { status: 400 })
  }

  const row = await db.interaction.findFirst({
    where: {
      id: interactionId,
      deletedAt: null,
      type: { in: ['email_received', 'email_sent'] },
    },
    select: { id: true, contactId: true, payload: true },
  })
  if (!row) return new NextResponse('not found', { status: 404 })

  // Access gate: read access to the linked Contact (restricted-access enforced
  // by contact.get). Unmatched mail is refused to Virtual Assistants but
  // allowed to other staff who are triaging the thread.
  if (row.contactId) {
    try {
      const caller = await createServerCaller()
      await caller.contact.get({ id: row.contactId, purpose: 'mail.attachment' })
    } catch {
      return new NextResponse('forbidden', { status: 403 })
    }
  } else if (me.role === 'virtual_assistant') {
    return new NextResponse('forbidden', { status: 403 })
  }

  const payload = (row.payload ?? {}) as { attachments?: MailAttachment[] }
  const list = Array.isArray(payload.attachments) ? payload.attachments : []
  const att = list[idx]
  if (!att || !att.s3Key) {
    return new NextResponse('attachment not stored', { status: 404 })
  }

  let result
  try {
    result = await getAttachment(att.s3Key)
  } catch {
    return new NextResponse('attachment fetch failed', { status: 502 })
  }

  const headers: HeadersInit = {
    'content-type': att.mimeType ?? result.contentType,
    'cache-control': 'private, max-age=0, no-store',
    'content-disposition': `inline; filename="${(att.filename ?? 'attachment').replace(/"/g, '_')}"`,
  }
  if (result.contentLength !== null) {
    headers['content-length'] = String(result.contentLength)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NextResponse(result.body as any, { status: 200, headers })
}
