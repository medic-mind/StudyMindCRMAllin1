// S3 helper for weekly cost-summary reports. CLAUDE.md §32.
//
// Lives in packages/core (not in an integration package) because it is the
// shared archival sink for cost reports, not specific to any provider. The
// worker boundary calls into here after the pure aggregator runs.
//
// Bucket: S3_COST_REPORTS_BUCKET. SSE: aws:kms with the env CMK
// (CLAUDE.md §21.1). Listing returns the most recent N keys under
// `cost-reports/`.

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

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
  const b = process.env['S3_COST_REPORTS_BUCKET']
  if (!b) throw new Error('S3_COST_REPORTS_BUCKET is not set')
  return b
}

function getKmsKeyId(): string | null {
  return process.env['AWS_KMS_KEY_ID'] ?? null
}

const KEY_PREFIX = 'cost-reports/'

export interface PutCostReportInput {
  /** ISO week, e.g. `2026-W19`. */
  weekIso: string
  /** Markdown body. */
  markdown: string
}

export interface PutCostReportResult {
  s3Key: string
}

/**
 * Idempotent put. Re-running for the same week overwrites the same key.
 */
export async function putCostReport(
  input: PutCostReportInput,
): Promise<PutCostReportResult> {
  const s3Key = `${KEY_PREFIX}${input.weekIso}.md`
  const kms = getKmsKeyId()
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: getBucket(),
      Key: s3Key,
      Body: input.markdown,
      ContentType: 'text/markdown; charset=utf-8',
      ...(kms
        ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kms }
        : { ServerSideEncryption: 'AES256' }),
    }),
  )
  return { s3Key }
}

/** A listed object with its eventual signed URL. */
export interface CostReportListing {
  s3Key: string
  weekIso: string
  lastModified: Date | null
}

/**
 * List the most recent N cost reports, newest first by LastModified.
 */
export async function listCostReports(limit = 12): Promise<CostReportListing[]> {
  const res = await getS3Client().send(
    new ListObjectsV2Command({
      Bucket: getBucket(),
      Prefix: KEY_PREFIX,
      // S3 returns up to 1000; we sort + slice client-side.
      MaxKeys: 1000,
    }),
  )
  const contents = res.Contents ?? []
  const rows: CostReportListing[] = contents
    .filter((o) => o.Key && o.Key.endsWith('.md'))
    .map((o) => {
      const key = o.Key as string
      const weekIso = key
        .substring(KEY_PREFIX.length)
        .replace(/\.md$/, '')
      return {
        s3Key: key,
        weekIso,
        lastModified: o.LastModified ?? null,
      }
    })
  rows.sort((a, b) => {
    const at = a.lastModified?.getTime() ?? 0
    const bt = b.lastModified?.getTime() ?? 0
    return bt - at
  })
  return rows.slice(0, limit)
}

/**
 * Return a 7-day signed URL for a cost report. Used for Slack post links
 * and for the in-app archive view.
 */
export async function signCostReportUrl(s3Key: string, ttlSeconds = 7 * 24 * 60 * 60): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
    { expiresIn: ttlSeconds },
  )
}

/** Read the markdown back. Used by the dashboard. */
export async function getCostReportMarkdown(s3Key: string): Promise<string> {
  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
  )
  if (!res.Body) throw new Error(`cost report missing for s3Key=${s3Key}`)
  // Body is a Readable in Node; transform to string.
  const stream = res.Body as unknown as NodeJS.ReadableStream
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks).toString('utf8')
}
