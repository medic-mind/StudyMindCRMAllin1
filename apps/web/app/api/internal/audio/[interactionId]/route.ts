// Audio streaming endpoint for call recordings (ADR 0017).
//
// The route reads the Interaction row for the caller, verifies the caller
// has read access to the linked Contact (gate via tRPC server caller +
// contact.get, which already enforces restricted-access), looks up the
// recording S3 key from the payload, and streams the object back. Access
// is audited as `interaction.recording_streamed`.
//
// We deliberately do not redirect to a presigned S3 URL — proxying through
// our edge keeps the audit record honest (the caller never holds a long-
// lived URL) and means we can throttle or block per-user without touching
// IAM.

import { NextResponse } from 'next/server'

import { writeAuditLogEntry } from '@studymind/audit'
import { getRecording } from '@studymind/integration-aircall/s3'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PayloadShape {
  recordingS3Key?: unknown
  aircallCallId?: unknown
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ interactionId: string }> },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { interactionId } = await params
  const row = await db.interaction.findFirst({
    where: { id: interactionId, deletedAt: null, type: 'call' },
    select: { id: true, contactId: true, payload: true },
  })
  if (!row) return new NextResponse('not found', { status: 404 })

  // Access gate: the caller must have read access to the linked Contact.
  // We delegate to `contact.get`, which enforces the restricted-access
  // attribute check (CLAUDE.md §42.3). When the interaction is not linked
  // to a Contact (Family-only call), we fall through to a role check.
  if (row.contactId) {
    try {
      const caller = await createServerCaller()
      await caller.contact.get({ id: row.contactId, purpose: 'audio.stream' })
    } catch {
      return new NextResponse('forbidden', { status: 403 })
    }
  } else if (me.role === 'virtual_assistant') {
    return new NextResponse('forbidden', { status: 403 })
  }

  const payload = (row.payload ?? {}) as PayloadShape
  const s3Key =
    typeof payload.recordingS3Key === 'string' ? payload.recordingS3Key : null
  if (!s3Key) {
    return new NextResponse('no recording on file', { status: 404 })
  }

  let stream: NodeJS.ReadableStream
  try {
    stream = await getRecording(s3Key)
  } catch {
    return new NextResponse('recording fetch failed', { status: 502 })
  }

  await writeAuditLogEntry(db, {
    actorId: me.id,
    action: 'interaction.recording_streamed',
    target: { type: 'Interaction', id: row.id },
    after: {
      s3Key,
      aircallCallId:
        typeof payload.aircallCallId === 'number' ? payload.aircallCallId : null,
    },
  })

  // Web standard Response can take a Node Readable in Node runtime via
  // ReadableStream interop.
  const range = req.headers.get('range')
  const headers: HeadersInit = {
    'content-type': 'audio/mpeg',
    'cache-control': 'private, max-age=0, no-store',
    'accept-ranges': 'bytes',
  }
  if (range) headers['content-range'] = range
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NextResponse(stream as any, { status: 200, headers })
}
