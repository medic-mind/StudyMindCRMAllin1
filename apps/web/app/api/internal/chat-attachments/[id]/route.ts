// Chat attachment download (ADR 0022 — richer messages). Streams a bound
// attachment back from S3 through the edge (never a presigned URL, so the
// access check is real and the audit honest — mirrors the Trengo attachment
// route). Access gate: the caller must be able to see the channel the
// attachment's message lives in (member, or any public channel).
//
// CLAUDE.md §20 (RBAC), §21.1 (KMS at rest).

import { NextResponse } from 'next/server'

import { getChatAttachment } from '@studymind/core/chat/s3'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const me = await getCurrentUser()
  if (!me) return new NextResponse('unauthenticated', { status: 401 })

  const { id } = await params
  const att = await db.chatAttachment.findUnique({
    where: { id },
    select: {
      filename: true,
      contentType: true,
      s3Key: true,
      message: { select: { channelId: true } },
    },
  })
  if (!att) return new NextResponse('not found', { status: 404 })

  // Access gate: visible if the channel is public, or the caller is a member.
  const channel = await db.chatChannel.findUnique({
    where: { id: att.message.channelId },
    select: { kind: true },
  })
  if (!channel) return new NextResponse('not found', { status: 404 })
  if (channel.kind !== 'public') {
    const membership = await db.chatChannelMember.findUnique({
      where: {
        channelId_userId: { channelId: att.message.channelId, userId: me.id },
      },
      select: { id: true },
    })
    if (!membership) return new NextResponse('forbidden', { status: 403 })
  }

  let result
  try {
    result = await getChatAttachment(att.s3Key)
  } catch {
    return new NextResponse('attachment fetch failed', { status: 502 })
  }

  const headers: HeadersInit = {
    'content-type': att.contentType,
    'cache-control': 'private, max-age=0, no-store',
    'content-disposition': `inline; filename="${att.filename.replace(/"/g, '_')}"`,
  }
  if (result.contentLength !== null) {
    headers['content-length'] = String(result.contentLength)
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new NextResponse(result.body as any, { status: 200, headers })
}
