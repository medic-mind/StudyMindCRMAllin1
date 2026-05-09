// DSAR export endpoint. CLAUDE.md §21.
//
// Admin-only. Streams a zip with every row mentioning the contact, decrypts
// safeguarding fields (each decryption writes a `safeguarding.field_decrypted`
// audit row before producing plaintext per CLAUDE.md §21.1), and includes a
// tamper-evident manifest of SHA-256 hashes.
//
// The export is generated on demand and never stored server-side. The
// operator's local download is the chain of custody.

import { auth } from '@clerk/nextjs/server'

import { buildDsarExport } from '@studymind/core/compliance/dsar'
import { withSentry } from '@studymind/core/observability/sentry'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withSentry(handleGet, { surface: 'dsar' })

async function handleGet(
  req: Request,
  ctx: { params: Promise<{ contactId: string }> },
): Promise<Response> {
  const { userId, sessionClaims } = await auth()
  if (!userId) {
    return new Response('unauthorised', { status: 401 })
  }
  const role = (sessionClaims?.['role'] as string | undefined) ?? 'agent'
  if (role !== 'admin') {
    return new Response('forbidden', { status: 403 })
  }

  const { contactId } = await ctx.params
  const requestId = req.headers.get('x-request-id') ?? `dsar-${Date.now()}-${userId}`

  const { stream } = await buildDsarExport(db, {
    contactId,
    actorId: userId,
    requestId,
  })

  const date = new Date().toISOString().slice(0, 10)
  const filename = `dsar-${contactId}-${date}.zip`

  // Pipe Node Readable -> Web ReadableStream so the App Router can stream it.
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      stream.on('end', () => controller.close())
      stream.on('error', (err) => controller.error(err))
    },
  })

  return new Response(webStream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-request-id': requestId,
    },
  })
}
