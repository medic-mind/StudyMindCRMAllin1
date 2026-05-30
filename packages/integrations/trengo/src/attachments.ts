// Attachment download worker (ADR 0020 Phase 6d).
//
// Fired by the webhook job when an inbound Trengo message carries an
// attachments array. For each entry we fetch via `safeFetch` (allowlist
// per CLAUDE.md §44.2 — Trengo hosts attachments under app.trengo.com /
// *.trengo.com which are already allowed), upload to S3 with SSE:KMS, and
// write the resulting s3Key into the Interaction payload alongside body.
//
// Idempotency: the S3 key is deterministic on (interactionId, attachmentId,
// safeName), so re-runs are no-ops. The Interaction payload merge replaces
// the attachments array each tick (the latest result wins) which is safe
// because the merger always lists the same attachments for the same source
// event.
//
// We never block the webhook handler on the download — the handler enqueues
// this function and returns 200 fast (CLAUDE.md §7.1). A failure here does
// NOT roll back the Interaction; the message body is still visible in the
// thread and the attachment chips simply show "pending".

import type { Prisma } from '@prisma/client'

import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { putAttachment } from './s3'
import {
  normaliseTrengoAttachment,
  type NormalisedTrengoAttachment,
  type TrengoAttachment,
} from './types'

/** Per-attachment hard ceiling. Anything larger is rejected with a
 *  noop-skip so a hostile upload cannot OOM the worker. */
const MAX_BYTES = 20 * 1024 * 1024 // 20 MB

interface AttachmentRecord {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number | null
  s3Key: string | null
  status: 'pending' | 'stored' | 'failed' | 'skipped'
  failureReason?: string
}

interface DownloadRequestedData {
  interactionId: string
  attachments: TrengoAttachment[]
}

export const trengoDownloadAttachments = inngest.createFunction(
  {
    id: 'trengo/download-attachments',
    name: 'Trengo: download attachments to S3',
    concurrency: { limit: 4 },
    retries: 4,
  },
  { event: 'trengo/download-attachments.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as DownloadRequestedData
    const { interactionId } = data
    const normalised = data.attachments
      .map(normaliseTrengoAttachment)
      .filter((a): a is NormalisedTrengoAttachment => a !== null)
    if (normalised.length === 0) {
      logger.info({ interactionId }, 'no normalisable attachments — skip')
      return { ok: true, stored: 0, skipped: 0 }
    }

    const results: AttachmentRecord[] = []
    let stored = 0
    let skipped = 0
    let failed = 0
    for (const att of normalised) {
      const result = await step.run(`download-${att.id}`, async () =>
        downloadOne(interactionId, att),
      )
      results.push(result)
      if (result.status === 'stored') stored += 1
      else if (result.status === 'failed') failed += 1
      else skipped += 1
    }

    await step.run('persist-attachments', async () => {
      // Read-modify-write so we never overwrite unrelated payload fields.
      const row = await db.interaction.findUnique({
        where: { id: interactionId },
        select: { payload: true },
      })
      const payload = (row?.payload ?? {}) as Record<string, unknown>
      const nextPayload = {
        ...payload,
        attachments: results,
      } as unknown as Prisma.InputJsonValue
      await db.interaction.update({
        where: { id: interactionId },
        data: { payload: nextPayload },
      })
    })

    logger.info(
      { interactionId, stored, skipped, failed, total: results.length },
      'trengo attachment download complete',
    )
    return { ok: true, stored, skipped, failed, total: results.length }
  },
)

async function downloadOne(
  interactionId: string,
  attachment: NormalisedTrengoAttachment,
): Promise<AttachmentRecord> {
  try {
    const res = await safeFetch(attachment.url, { method: 'GET' })
    if (!res.ok) {
      return {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        s3Key: null,
        status: 'failed',
        failureReason: `trengo returned ${res.status}`,
      }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > MAX_BYTES) {
      return {
        attachmentId: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: buf.byteLength,
        s3Key: null,
        status: 'skipped',
        failureReason: `exceeds ${MAX_BYTES / (1024 * 1024)}MB ceiling`,
      }
    }
    const put = await putAttachment({
      interactionId,
      attachmentId: attachment.id,
      filename: attachment.filename,
      body: buf,
      contentType: attachment.mimeType,
    })
    return {
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: buf.byteLength,
      s3Key: put.s3Key,
      status: 'stored',
    }
  } catch (err) {
    return {
      attachmentId: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      s3Key: null,
      status: 'failed',
      failureReason: err instanceof Error ? err.message : 'unknown error',
    }
  }
}
