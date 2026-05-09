// S3 helper for AuditLogEntry archive batches. CLAUDE.md §17.1, §21.
//
// Bucket: S3_AUDIT_ARCHIVES_BUCKET. SSE: aws:kms with AWS_KMS_KEY_ID
// (CLAUDE.md §21.1) when set, else AES256. The archive is treated as cold
// storage: the worker boundary uploads gzipped NDJSON; lifecycle in IaC
// transitions to Glacier Deep Archive after 30 d.
//
// We share the cost-reports S3 client; the bucket is the one piece of
// configuration that varies.

import { PutObjectCommand } from '@aws-sdk/client-s3'

import { getS3Client } from './cost-reports-s3'

function getBucket(): string {
  const b = process.env['S3_AUDIT_ARCHIVES_BUCKET']
  if (!b) throw new Error('S3_AUDIT_ARCHIVES_BUCKET is not set')
  return b
}

function getKmsKeyId(): string | null {
  return process.env['AWS_KMS_KEY_ID'] ?? null
}

export interface PutAuditArchiveInput {
  /** S3 key, e.g. `audit-archives/2026/2026-05-10-<batchId>.ndjson.gz`. */
  s3Key: string
  /** Gzipped NDJSON body. */
  body: Buffer
  /** Sha-256 hex of the *uncompressed* NDJSON for downstream verification. */
  sha256: string
  /** Number of rows in the batch — surfaced as object metadata. */
  rowCount: number
}

export async function putAuditArchive(input: PutAuditArchiveInput): Promise<void> {
  const kms = getKmsKeyId()
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: input.s3Key,
      Body: input.body,
      ContentType: 'application/x-ndjson',
      ContentEncoding: 'gzip',
      Metadata: {
        'sha256-uncompressed': input.sha256,
        'row-count': String(input.rowCount),
      },
      ...(kms
        ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kms }
        : { ServerSideEncryption: 'AES256' }),
    }),
  )
}
