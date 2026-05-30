// S3 client for Trengo attachments. ADR 0020 Phase 6d.
// CLAUDE.md §32 (lifecycle), §21.1 (KMS encryption at rest).
//
// Stream attachments to S3 on first sync; reference by S3 key in
// `Interaction.payload.attachments[].s3Key`. Mirrors the Gmail attachment
// pattern (`packages/integrations/gmail/src/s3.ts`) — same SSE:KMS, same
// idempotent path, same getter/injector shape so tests can swap the client.

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

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
  // Falls back to the shared attachments bucket — Gmail and Trengo can
  // share since the key prefix segregates them. A self-hosted install
  // that wants a dedicated Trengo bucket sets S3_TRENGO_ATTACHMENTS_BUCKET.
  const b =
    process.env['S3_TRENGO_ATTACHMENTS_BUCKET'] ??
    process.env['S3_GMAIL_ATTACHMENTS_BUCKET']
  if (!b) {
    throw new Error(
      'S3_TRENGO_ATTACHMENTS_BUCKET (or S3_GMAIL_ATTACHMENTS_BUCKET) is not set',
    )
  }
  return b
}

function getKmsKeyId(): string {
  const k = process.env['AWS_KMS_KEY_ID']
  if (!k) throw new Error('AWS_KMS_KEY_ID is not set')
  return k
}

export interface PutTrengoAttachmentInput {
  interactionId: string
  attachmentId: string
  filename: string
  body: Buffer
  contentType: string
}

export interface PutTrengoAttachmentResult {
  s3Key: string
}

/**
 * Idempotent put under trengo/attachments/{interactionId}/{attachmentId}/{filename}.
 * SSE: aws:kms with the environment CMK. Re-uploads are no-ops because
 * Trengo retries arrive with the same `interactionId` + `attachmentId`.
 */
export async function putAttachment(
  input: PutTrengoAttachmentInput,
): Promise<PutTrengoAttachmentResult> {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  const s3Key = `trengo/attachments/${input.interactionId}/${input.attachmentId}/${safeName}`
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

export function buildAttachmentS3Key(input: {
  interactionId: string
  attachmentId: string
  filename: string
}): string {
  const safeName = input.filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
  return `trengo/attachments/${input.interactionId}/${input.attachmentId}/${safeName}`
}

export interface GetAttachmentResult {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength: number | null
}

/**
 * Stream an attachment back from S3. Mirrors `getRecording` in the Aircall
 * package so the internal download route can pipe directly to the
 * response. Throws when the object is missing — the route returns 404.
 */
export async function getAttachment(s3Key: string): Promise<GetAttachmentResult> {
  const client = getS3Client()
  const res = await client.send(
    new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
  )
  if (!res.Body) {
    throw new Error(`attachment ${s3Key} has no body`)
  }
  return {
    body: res.Body as NodeJS.ReadableStream,
    contentType: res.ContentType ?? 'application/octet-stream',
    contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : null,
  }
}
