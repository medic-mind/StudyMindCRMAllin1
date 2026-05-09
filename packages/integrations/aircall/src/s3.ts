// S3 client for Aircall recordings. CLAUDE.md §10, §32.
//
// Aircall deletes the recording (and any AI-derived transcript) when the
// retention window expires; if a parent contract requires longer retention
// we persist a copy in S3 first. Server-side encryption uses the same KMS
// CMK as field-level encryption (CLAUDE.md §21.1).

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

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
  const b = process.env['S3_RECORDINGS_BUCKET']
  if (!b) throw new Error('S3_RECORDINGS_BUCKET is not set')
  return b
}

function getKmsKeyId(): string {
  const k = process.env['AWS_KMS_KEY_ID']
  if (!k) throw new Error('AWS_KMS_KEY_ID is not set')
  return k
}

export interface PutRecordingInput {
  callId: number
  body: Buffer | Uint8Array
  contentType: string
}

export interface PutRecordingResult {
  s3Key: string
}

/**
 * Persist an Aircall recording to S3 under aircall/recordings/{callId}.
 * Idempotent: re-puts the same key overwrite-safely. SSE: aws:kms with the
 * environment CMK.
 */
export async function putRecording(input: PutRecordingInput): Promise<PutRecordingResult> {
  const s3Key = `aircall/recordings/${input.callId}`
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

/**
 * Read a recording back as a Node Readable stream.
 * Throws if the key does not exist or returns a non-stream body.
 */
export async function getRecording(s3Key: string): Promise<NodeJS.ReadableStream> {
  const client = getS3Client()
  const res = await client.send(
    new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
  )
  if (!res.Body) throw new Error(`recording missing for s3Key=${s3Key}`)
  // The SDK returns a Readable in Node; cast through unknown for safety.
  return res.Body as unknown as NodeJS.ReadableStream
}

/**
 * Helper: collect a recording stream into a Buffer. Used by the Whisper
 * step; Whisper takes a Buffer.
 */
export async function getRecordingBuffer(s3Key: string): Promise<Buffer> {
  const stream = await getRecording(s3Key)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}
