// S3 client for Gmail attachments. CLAUDE.md §14, §32.
// Stream attachments to S3 on first sync; reference by S3 key in
// Interaction.payload.attachments[]. Lifecycle: 90 d standard then Glacier.

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

let cached: S3Client | null = null
let injected: S3Client | null = null

export function getS3Client(): S3Client {
  if (injected) return injected
  if (cached) return cached
  cached = new S3Client({ region: process.env['AWS_REGION'] ?? 'eu-west-2' })
  return cached
}

export function setS3Client(client: S3Client | null): void {
  injected = client
  cached = null
}

function getBucket(): string {
  const b = process.env['S3_GMAIL_ATTACHMENTS_BUCKET']
  if (!b) throw new Error('S3_GMAIL_ATTACHMENTS_BUCKET is not set')
  return b
}

function getKmsKeyId(): string {
  const k = process.env['AWS_KMS_KEY_ID']
  if (!k) throw new Error('AWS_KMS_KEY_ID is not set')
  return k
}

export interface PutAttachmentInput {
  messageId: string
  attachmentId: string
  filename: string
  body: Buffer
  contentType: string
}

export interface PutAttachmentResult {
  s3Key: string
}

/**
 * Idempotent put under gmail/attachments/{messageId}/{attachmentId}/{filename}.
 * SSE: aws:kms with the environment CMK (CLAUDE.md §21.1).
 */
export async function putAttachment(
  input: PutAttachmentInput,
): Promise<PutAttachmentResult> {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  const s3Key = `gmail/attachments/${input.messageId}/${input.attachmentId}/${safeName}`
  const client = getS3Client()
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
