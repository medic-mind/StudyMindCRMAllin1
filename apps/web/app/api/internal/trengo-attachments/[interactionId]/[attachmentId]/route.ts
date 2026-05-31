// Trengo attachment download endpoint (ADR 0020 Phase 6d).
//
// Streams an attachment back from S3. The route reads the Interaction row
// for the caller, verifies the caller has read access to the linked Contact
// (gate via the tRPC server caller + contact.get, which already enforces
// restricted-access), looks up the attachment's S3 key from the payload,
// and pipes the object back.
//
// We proxy through the edge rather than redirecting to a presigned S3 URL
// so the audit record stays honest (the caller never holds a long-lived
// URL) and so we can throttle or block per-user without touching IAM.

import { NextResponse } from 'next/server'

import { getAttachment } from '@studymind/integration-trengo/s3'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface AttachmentRecord {
  attachmentId?: string
  filename?: string
  mimeType?: string
  s3Key?: string | null
  status?: string
}

export async function GET(
  _req: Request,
  {
    params,
  }: {
    params: Promise<{ interactionId: string; attachmentId: string }>
  },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { interactionId, attachmentId } = await params
  const row = await db.interaction.findFirst({
    where: { id: interactionId, deletedAt: null, type: 'message' },
    select: { id: true, contactId: true, payload: true },
  })
  if (!row) return new NextResponse('not found', { status: 404 })

  // Access gate: the caller must have read access to the linked Contact.
  // We delegate to `contact.get`, which enforces restricted-access
  // attribute checks. When the message is not linked to a Contact, we
  // refuse Virtual Assistants and otherwise allow staff to download
  // unmatched attachments (they're triaging the conversation).
  if (row.contactId) {
    try {
      const caller = await createServerCaller()
      await caller.contact.get({
        id: row.contactId,
        purpose: 'trengo.attachment',
      })
    } catch {
      return new NextResponse('forbidden', { status: 403 })
    }
  } else if (me.role === 'virtual_assistant') {
    return new NextResponse('forbidden', { status: 403 })
  }

  const payload = (row.payload ?? {}) as { attachments?: AttachmentRecord[] }
  const list = Array.isArray(payload.attachments) ? payload.attachments : []
  const att = list.find((a) => a?.attachmentId === attachmentId)
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
