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
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { getRecordingBuffer } from '@studymind/integration-aircall/s3'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { createServerCaller } from '@/lib/trpc/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface PayloadShape {
  recordingS3Key?: unknown
  recordingUrl?: unknown
  voicemailUrl?: unknown
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
  // Fall back to the provider recording/voicemail URL for calls whose audio has
  // not been copied into S3 yet (every live webhook call stores `recordingUrl`,
  // but the S3 copy is written asynchronously by the persist-recording job /
  // backfill). This makes existing recordings listenable immediately; the host
  // is already allowlisted for `safeFetch` (it's the same URL the transcribe
  // fallback downloads).
  const providerUrl =
    typeof payload.recordingUrl === 'string' && payload.recordingUrl
      ? payload.recordingUrl
      : typeof payload.voicemailUrl === 'string' && payload.voicemailUrl
        ? payload.voicemailUrl
        : null

  if (!s3Key && !providerUrl) {
    return new NextResponse('no recording on file', { status: 404 })
  }

  const aircallCallId =
    typeof payload.aircallCallId === 'number' ? payload.aircallCallId : null

  // Resolve the audio bytes from the best available source, then serve them
  // with proper HTTP Range support below. We buffer the whole object (call
  // recordings are small) so we can return an accurate Content-Length and honour
  // seek requests — without that the browser cannot determine the clip's
  // duration, which is why the player's timer/scrubber was wrong and glitchy.
  let buf: Buffer
  let contentType = 'audio/mpeg'
  let auditAfter: Record<string, unknown>

  if (s3Key) {
    // S3 copy — preferred (durable, lifecycle-managed).
    try {
      buf = await getRecordingBuffer(s3Key)
    } catch {
      return new NextResponse('recording fetch failed', { status: 502 })
    }
    auditAfter = { source: 's3', s3Key, aircallCallId }
  } else {
    // No durable S3 copy yet. Aircall's stored recording URL is short-lived, so
    // when we know the Aircall call id we refetch the call to get a CURRENT URL
    // (the stored one has usually expired — the likely reason playback failed).
    // Fall back to whatever we stored (Google Voice voicemail, or if the
    // refetch can't run because Aircall isn't configured).
    let fetchUrl = providerUrl as string
    if (aircallCallId != null) {
      try {
        const { createClient } = await import('@studymind/integration-aircall/client')
        const fresh = await createClient().getCall(aircallCallId)
        if (fresh.recording) fetchUrl = fresh.recording
      } catch {
        // Aircall env unset or API error — use the stored URL.
      }
    }
    // Proxy the provider URL through our edge (bytes never leave a long-lived
    // URL with the caller; the access stays audited).
    try {
      const res = await safeFetch(fetchUrl)
      if (!res.ok) return new NextResponse('recording fetch failed', { status: 502 })
      contentType = res.headers.get('content-type') ?? 'audio/mpeg'
      buf = Buffer.from(await res.arrayBuffer())
    } catch {
      return new NextResponse('recording unavailable', { status: 502 })
    }
    auditAfter = { source: 'provider_url', aircallCallId }
  }

  await writeAuditLogEntry(db, {
    actorId: me.id,
    action: 'interaction.recording_streamed',
    target: { type: 'Interaction', id: row.id },
    after: auditAfter,
  })

  return buildAudioResponse(buf, contentType, req.headers.get('range'))
}

/**
 * Serve audio bytes with correct HTTP Range semantics so the browser can read
 * the clip duration and seek. A `Range` request gets a 206 with a proper
 * `Content-Range` + sliced `Content-Length`; otherwise a 200 with the full
 * `Content-Length`. Both advertise `Accept-Ranges: bytes`.
 */
function buildAudioResponse(
  buf: Buffer,
  contentType: string,
  rangeHeader: string | null,
): Response {
  const total = buf.length
  const baseHeaders: Record<string, string> = {
    'content-type': contentType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0, no-store',
  }

  const match = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null
  if (match) {
    const startRaw = match[1]
    const endRaw = match[2]
    let start: number
    let end: number
    if (!startRaw && endRaw) {
      // Suffix range: "bytes=-N" → the last N bytes.
      const n = Number.parseInt(endRaw, 10)
      start = Math.max(0, total - n)
      end = total - 1
    } else {
      start = startRaw ? Number.parseInt(startRaw, 10) : 0
      end = endRaw ? Number.parseInt(endRaw, 10) : total - 1
    }

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return new NextResponse('range not satisfiable', {
        status: 416,
        headers: { 'accept-ranges': 'bytes', 'content-range': `bytes */${total}` },
      })
    }
    end = Math.min(end, total - 1)
    const chunk = buf.subarray(start, end + 1)
    return new NextResponse(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...baseHeaders,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(chunk.length),
      },
    })
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: { ...baseHeaders, 'content-length': String(total) },
  })
}
