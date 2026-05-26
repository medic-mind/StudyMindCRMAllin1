// AWS KMS client factory. CLAUDE.md §21.1.
//
// Centralised so tests can swap a mock client and production wires the SDK
// once. The CMK id comes from env (AWS_KMS_KEY_ID); the region from
// AWS_REGION (default eu-west-2 — CLAUDE.md §3 hosting).

import { KMSClient } from '@aws-sdk/client-kms'

let cached: KMSClient | null = null
let injected: KMSClient | null = null

export function getKmsClient(): KMSClient {
  if (injected) return injected
  if (cached) return cached
  cached = new KMSClient({
    region: process.env['AWS_REGION'] ?? 'eu-west-2',
  })
  return cached
}

/** Test seam — set a mock client. Pass `null` to clear. */
export function setKmsClient(client: KMSClient | null): void {
  injected = client
  cached = null
}

export function getKmsKeyId(): string {
  const id = process.env['AWS_KMS_KEY_ID']
  if (!id) {
    throw new Error('AWS_KMS_KEY_ID is not set — KMS operations require a CMK id')
  }
  return id
}

/**
 * True when a CMK is configured. When false, field encryption falls back to a
 * local AES master key (see envelope.ts) so a self-hosted install without AWS
 * still works. KMS stays the preferred backend whenever this returns true.
 */
export function isKmsConfigured(): boolean {
  return Boolean(process.env['AWS_KMS_KEY_ID']?.trim())
}

export const KEY_VERSION = 1 as const
