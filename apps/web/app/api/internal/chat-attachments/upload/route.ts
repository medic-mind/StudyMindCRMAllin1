// Chat attachment upload (ADR 0022 — richer messages). Phase 1 of the two-phase
// upload: the client POSTs the file bytes here; we validate, mint an
// attachmentId, stage the bytes to S3 (SSE:KMS), and return the metadata the
// client then passes to `chat.send`. The bytes are written under the key the
// bound row will reference, so binding is just persisting the metadata — no S3
// copy. Orphaned stages (uploaded, never sent) are swept by S3 lifecycle.
//
// CLAUDE.md §20 (staff-gated), §21.1 (KMS at rest), §44.2 (we never trust the
// client for the S3 key — it's derived from the id we mint).

import { NextResponse } from 'next/server'

import { createId } from '@paralleldrive/cuid2'

import {
  CHAT_ATTACHMENT_MAX_BYTES,
  isAllowedAttachment,
  putChatAttachment,
  sanitiseFilename,
} from '@studymind/core/chat/s3'

import { getCurrentUser } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const form = await req.formData().catch(() => null)
  const file = form?.get('file')
  if (!form || !(file instanceof File)) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  const filename = sanitiseFilename(file.name || 'file')
  if (!isAllowedAttachment(filename)) {
    return NextResponse.json(
      { error: 'That file type is not allowed' },
      { status: 415 },
    )
  }
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
    return NextResponse.json(
      { error: 'File is larger than the 20 MB limit' },
      { status: 413 },
    )
  }

  const id = createId()
  const buffer = Buffer.from(await file.arrayBuffer())
  const contentType = file.type || 'application/octet-stream'

  let s3Key: string
  try {
    const result = await putChatAttachment({
      attachmentId: id,
      filename,
      body: buffer,
      contentType,
    })
    s3Key = result.s3Key
  } catch {
    // Surfaced to the composer as a non-fatal upload failure; the message can
    // still be sent without the attachment.
    return NextResponse.json({ error: 'Upload failed' }, { status: 502 })
  }

  return NextResponse.json({
    id,
    filename,
    contentType,
    sizeBytes: buffer.byteLength,
    s3Key,
  })
}
