// S3 storage for chat attachments (ADR 0022 — richer messages).
// CLAUDE.md §21.1 (KMS envelope at rest), §32 (lifecycle). Mirrors the Trengo
// and Gmail attachment modules: same SSE:KMS, same getter/injector seam so
// tests can swap the client, same proxy-download shape.
//
// Bytes are staged to S3 *before* the message exists (two-phase upload), keyed
// by a freshly-minted attachmentId, then bound to the message on send. Orphaned
// stages (uploaded but never sent) are swept by S3 lifecycle on the staging
// prefix — they are written under the same key the bound row will reference, so
// "binding" is just persisting the metadata row; no S3 copy is needed.

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

let cached: S3Client | null = null
let injected: S3Client | null = null

export function getChatS3Client(): S3Client {
  if (injected) return injected
  if (cached) return cached
  cached = new S3Client({ region: process.env['AWS_REGION'] ?? 'eu-west-2' })
  return cached
}

/** Test seam — swap the S3 client for a mock. Pass null to reset. */
export function setChatS3Client(client: S3Client | null): void {
  injected = client
  cached = null
}

function getBucket(): string {
  // Shares the attachments bucket with Gmail/Trengo — the `chat/` key prefix
  // segregates it. A self-hosted install can pin a dedicated bucket.
  const b =
    process.env['S3_CHAT_ATTACHMENTS_BUCKET'] ??
    process.env['S3_GMAIL_ATTACHMENTS_BUCKET'] ??
    process.env['S3_TRENGO_ATTACHMENTS_BUCKET']
  if (!b) {
    throw new Error(
      'S3_CHAT_ATTACHMENTS_BUCKET (or S3_GMAIL_ATTACHMENTS_BUCKET) is not set',
    )
  }
  return b
}

function getKmsKeyId(): string {
  const k = process.env['AWS_KMS_KEY_ID']
  if (!k) throw new Error('AWS_KMS_KEY_ID is not set')
  return k
}

export function sanitiseFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'file'
}

/**
 * S3 key for a staged/bound attachment. `messageId` is `staging` until the
 * attachment is bound to a real message — but because we mint the attachmentId
 * up front and the bound row simply records this key, we key on attachmentId
 * alone so no copy is needed at bind time.
 */
export function buildChatAttachmentKey(input: {
  attachmentId: string
  filename: string
}): string {
  return `chat/attachments/${input.attachmentId}/${sanitiseFilename(input.filename)}`
}

export interface PutChatAttachmentInput {
  attachmentId: string
  filename: string
  body: Buffer
  contentType: string
}

/** Idempotent put under chat/attachments/{attachmentId}/{filename}, SSE:KMS. */
export async function putChatAttachment(
  input: PutChatAttachmentInput,
): Promise<{ s3Key: string }> {
  const s3Key = buildChatAttachmentKey(input)
  const client = getChatS3Client()
  await client.send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: s3Key,
      Body: input.body,
      ContentType: input.contentType,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: getKmsKeyId(),
    }),
  )
  return { s3Key }
}

export interface GetChatAttachmentResult {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength: number | null
}

/** Stream an attachment back from S3 for the proxy download route. */
export async function getChatAttachment(s3Key: string): Promise<GetChatAttachmentResult> {
  const client = getChatS3Client()
  const res = await client.send(
    new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
  )
  if (!res.Body) throw new Error(`chat attachment ${s3Key} has no body`)
  return {
    body: res.Body as NodeJS.ReadableStream,
    contentType: res.ContentType ?? 'application/octet-stream',
    contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
  }
}

// --- Upload policy ------------------------------------------------------------

/** Per-file ceiling. Matches the Trengo attachment ceiling (CLAUDE.md §37). */
export const CHAT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024 // 20 MB
/** Max attachments per message — keeps a single row's render bounded. */
export const CHAT_ATTACHMENT_MAX_PER_MESSAGE = 10

/**
 * Allowed content types. Images render inline; the rest download. We block
 * executables and scripts outright (defence-in-depth — the bucket is private
 * and served via the proxy, but we never want to host active content).
 */
const BLOCKED_EXTENSIONS = new Set([
  'exe', 'bat', 'cmd', 'sh', 'com', 'msi', 'scr', 'js', 'jar', 'app', 'dll',
])

export function isAllowedAttachment(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return !BLOCKED_EXTENSIONS.has(ext)
}

export function isImageContentType(contentType: string): boolean {
  return /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i.test(contentType)
}
