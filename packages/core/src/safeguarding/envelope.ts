// Envelope DEK wrap/unwrap with a pluggable backend. CLAUDE.md §21.1.
//
// AWS KMS is the preferred backend. But a self-hosted install may run without
// AWS provisioned (KMS env vars unset). Rather than hard-fail every
// field-encryption write — Trengo per-agent tokens (§11), Gmail refresh
// tokens (§14) — we fall back to a local AES-256 master key.
//
// Backend selection:
//   - generateDataKey(): KMS if AWS_KMS_KEY_ID is set, else the local key.
//   - unwrapDataKey():   routes per-row on an 8-byte sentinel that
//     locally-wrapped DEKs carry and KMS CiphertextBlobs never do. So rows
//     written under KMS keep decrypting via KMS even after a host enables the
//     local backend, and vice versa — no migration, no schema change.
//
// Local master key resolution (first match wins):
//   1. CRM_LOCAL_ENCRYPTION_KEY — base64 or hex, must decode to 32 bytes.
//      Recommended for self-hosted production.
//   2. Derived from AUTH_SECRET via HKDF-SHA256. Zero-config fallback so a
//      deploy without AWS works out of the box. AUTH_SECRET is already a
//      stable secret (rotating it logs everyone out), so binding field
//      encryption to it adds no new "do not rotate" constraint in practice.
//   3. None set -> throw. Fails closed; we never invent an ephemeral key
//      (that would make stored ciphertext permanently undecryptable).

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms'

import { logger } from '../logger'
import { getKmsClient, getKmsKeyId, isKmsConfigured } from './kms'

// 8-byte ASCII sentinel prefixing locally-wrapped DEKs. AWS KMS CiphertextBlobs
// are binary-framed and do not begin with this value, so it is a safe
// discriminator between the two backends.
const LOCAL_DEK_MAGIC = Buffer.from('SMxLOCAL', 'utf8')
const LOCAL_IV_BYTES = 12
const GCM_TAG_BYTES = 16
const DEK_BYTES = 32

export interface GeneratedDataKey {
  /** Plaintext DEK (32 bytes). Caller MUST zero it after use. */
  plaintext: Buffer
  /** Wrapped DEK to persist (EncryptedField / TrengoToken `dekCiphertext`). */
  ciphertext: Buffer
}

/**
 * Produce a fresh AES-256 data key plus its wrapped form. KMS when configured,
 * otherwise the local master key.
 */
export async function generateDataKey(): Promise<GeneratedDataKey> {
  if (isKmsConfigured()) {
    const kms = getKmsClient()
    const dk = await kms.send(
      new GenerateDataKeyCommand({ KeyId: getKmsKeyId(), KeySpec: 'AES_256' }),
    )
    if (!dk.Plaintext || !dk.CiphertextBlob) {
      throw new Error('KMS GenerateDataKey returned no key material')
    }
    return {
      plaintext: Buffer.from(dk.Plaintext),
      ciphertext: Buffer.from(dk.CiphertextBlob),
    }
  }

  const master = getLocalMasterKey()
  try {
    const plaintext = randomBytes(DEK_BYTES)
    const iv = randomBytes(LOCAL_IV_BYTES)
    const cipher = createCipheriv('aes-256-gcm', master, iv)
    const wrapped = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    // sentinel || iv || tag || wrapped-dek
    const ciphertext = Buffer.concat([LOCAL_DEK_MAGIC, iv, tag, wrapped])
    return { plaintext, ciphertext }
  } finally {
    master.fill(0)
  }
}

/**
 * Recover the plaintext DEK from its wrapped form. Routes to the local backend
 * when the blob carries the local sentinel, else to KMS.
 */
export async function unwrapDataKey(dekCiphertext: Uint8Array): Promise<Buffer> {
  const blob = Buffer.from(dekCiphertext)

  if (isLocallyWrapped(blob)) {
    const master = getLocalMasterKey()
    try {
      const off = LOCAL_DEK_MAGIC.length
      const iv = blob.subarray(off, off + LOCAL_IV_BYTES)
      const tag = blob.subarray(off + LOCAL_IV_BYTES, off + LOCAL_IV_BYTES + GCM_TAG_BYTES)
      const wrapped = blob.subarray(off + LOCAL_IV_BYTES + GCM_TAG_BYTES)
      const decipher = createDecipheriv('aes-256-gcm', master, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(wrapped), decipher.final()])
    } finally {
      master.fill(0)
    }
  }

  const kms = getKmsClient()
  const dek = await kms.send(new DecryptCommand({ CiphertextBlob: blob }))
  if (!dek.Plaintext) {
    throw new Error('KMS Decrypt returned no key material')
  }
  return Buffer.from(dek.Plaintext)
}

function isLocallyWrapped(blob: Buffer): boolean {
  return (
    blob.length >= LOCAL_DEK_MAGIC.length &&
    blob.subarray(0, LOCAL_DEK_MAGIC.length).equals(LOCAL_DEK_MAGIC)
  )
}

let warnedDerived = false

function getLocalMasterKey(): Buffer {
  const explicit = process.env['CRM_LOCAL_ENCRYPTION_KEY']?.trim()
  if (explicit) {
    const key = decodeKeyMaterial(explicit)
    if (key.length !== DEK_BYTES) {
      throw new Error(
        'CRM_LOCAL_ENCRYPTION_KEY must decode to exactly 32 bytes (AES-256). ' +
          'Generate one with: openssl rand -base64 32',
      )
    }
    return key
  }

  const authSecret = (process.env['AUTH_SECRET'] ?? process.env['NEXTAUTH_SECRET'])?.trim()
  if (authSecret) {
    if (!warnedDerived) {
      warnedDerived = true
      logger.warn(
        { backend: 'local-derived' },
        'AWS_KMS_KEY_ID unset; deriving the field-encryption key from ' +
          'AUTH_SECRET. Set CRM_LOCAL_ENCRYPTION_KEY or provision KMS for ' +
          'production, and do not rotate AUTH_SECRET without re-encrypting ' +
          'stored tokens.',
      )
    }
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(authSecret, 'utf8'),
        Buffer.from('studymind-crm/field-encryption', 'utf8'), // salt
        Buffer.from('envelope-dek-wrap/v1', 'utf8'), // info
        DEK_BYTES,
      ),
    )
  }

  throw new Error(
    'Field encryption needs a key but none is configured. Set AWS_KMS_KEY_ID ' +
      '(KMS, preferred), or CRM_LOCAL_ENCRYPTION_KEY (a base64 32-byte key: ' +
      'openssl rand -base64 32). AUTH_SECRET is used as a last-resort fallback.',
  )
}

function decodeKeyMaterial(raw: string): Buffer {
  // 64 hex chars -> 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  // Otherwise base64 / base64url.
  return Buffer.from(raw, 'base64')
}
