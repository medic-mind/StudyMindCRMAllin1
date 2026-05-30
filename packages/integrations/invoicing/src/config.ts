// Invoicing integration config: the API key (sk_live_…) and webhook secret
// (whsec_…) are envelope-encrypted at rest, mirroring the Trengo per-agent
// token pattern (packages/integrations/trengo/src/connect.ts). CLAUDE.md §21.
//
// Secrets are wrapped with a per-row DEK (KMS when configured, else the local
// AES-256 key). We never log the plaintext and never return the whole key to
// the UI — only the last 4 chars of the API key for an at-a-glance check.

import { createCipheriv, randomBytes } from 'node:crypto'

import { writeAuditLogEntry } from '@studymind/audit'
import { decryptField, generateDataKey, KEY_VERSION } from '@studymind/core/safeguarding'
import { db } from '@studymind/db'

export const SETTING_ID = 'default' as const
export const DEFAULT_BASE_URL = 'https://b2b.studymind.co.uk' as const

export interface InvoicingConfig {
  baseUrl: string
  apiKey: string | null
  webhookSecret: string | null
  apiKeyLast4: string | null
  eventsCursor: string | null
  streamCursor: string | null
}

interface EnvelopeColumns {
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}

/** Envelope-encrypt a secret. Mirrors core/safeguarding/encrypt.ts but writes
 *  into the InvoicingSetting columns rather than EncryptedField. */
async function wrapSecret(field: string, plaintext: string): Promise<EnvelopeColumns> {
  const { plaintext: dekPlain, ciphertext: dekCiphertext } = await generateDataKey()
  const iv = randomBytes(12)
  const aad = Buffer.from(`InvoicingSetting|${SETTING_ID}|${field}|${KEY_VERSION}`, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', dekPlain, iv)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const ciphertext = Buffer.concat([enc, tag])
  dekPlain.fill(0)
  return { ciphertext, iv, dekCiphertext, aad, keyVersion: KEY_VERSION }
}

async function unwrapSecret(
  cols: {
    ciphertext: Uint8Array | null
    iv: Uint8Array | null
    dekCiphertext: Uint8Array | null
    aad: Uint8Array | null
    keyVersion: number | null
  },
  purpose: string,
): Promise<string | null> {
  if (
    !cols.ciphertext ||
    !cols.iv ||
    !cols.dekCiphertext ||
    !cols.aad ||
    cols.keyVersion === null
  ) {
    return null
  }
  return decryptField(
    {
      ciphertext: cols.ciphertext,
      iv: cols.iv,
      dekCiphertext: cols.dekCiphertext,
      aad: cols.aad,
      keyVersion: cols.keyVersion,
    },
    { actorId: null, purpose },
  )
}

/**
 * Load the full config with secrets decrypted. Used by outbound calls and the
 * webhook verifier. Returns nulls when not yet configured (caller fails
 * closed). Falls back to env vars so a Railway-only deploy works without first
 * pasting into the UI.
 */
export async function loadInvoicingConfig(): Promise<InvoicingConfig> {
  const row = await db.invoicingSetting.findUnique({ where: { id: SETTING_ID } })

  const envApiKey = process.env['INVOICING_API_KEY']?.trim() || null
  const envSecret = process.env['INVOICING_WEBHOOK_SECRET']?.trim() || null
  const envBaseUrl = process.env['INVOICING_API_BASE_URL']?.trim() || null

  if (!row) {
    return {
      baseUrl: envBaseUrl ?? DEFAULT_BASE_URL,
      apiKey: envApiKey,
      webhookSecret: envSecret,
      apiKeyLast4: envApiKey ? envApiKey.slice(-4) : null,
      eventsCursor: null,
      streamCursor: null,
    }
  }

  const apiKey =
    (await unwrapSecret(
      {
        ciphertext: row.apiKeyCiphertext,
        iv: row.apiKeyIv,
        dekCiphertext: row.apiKeyDekCiphertext,
        aad: row.apiKeyAad,
        keyVersion: row.apiKeyKeyVersion,
      },
      'invoicing.outbound',
    )) ?? envApiKey

  const webhookSecret =
    (await unwrapSecret(
      {
        ciphertext: row.webhookSecretCiphertext,
        iv: row.webhookSecretIv,
        dekCiphertext: row.webhookSecretDekCiphertext,
        aad: row.webhookSecretAad,
        keyVersion: row.webhookSecretKeyVersion,
      },
      'invoicing.webhook_verify',
    )) ?? envSecret

  return {
    baseUrl: row.baseUrl || envBaseUrl || DEFAULT_BASE_URL,
    apiKey,
    webhookSecret,
    apiKeyLast4: row.apiKeyLast4 ?? (apiKey ? apiKey.slice(-4) : null),
    eventsCursor: row.eventsCursor,
    streamCursor: row.streamCursor,
  }
}

export interface SaveConfigInput {
  baseUrl?: string
  apiKey?: string | null
  webhookSecret?: string | null
  actorId: string
  requestId: string
}

/**
 * Persist config. Only the fields supplied are changed — passing `apiKey`
 * undefined leaves the stored key intact; passing an empty string clears it.
 * Writes an audit row (never the secret value).
 */
export async function saveInvoicingConfig(input: SaveConfigInput): Promise<void> {
  const data: Record<string, unknown> = { updatedById: input.actorId }
  const create: Record<string, unknown> = {
    id: SETTING_ID,
    baseUrl: input.baseUrl?.trim() || DEFAULT_BASE_URL,
    createdById: input.actorId,
    updatedById: input.actorId,
  }

  if (input.baseUrl !== undefined) {
    data['baseUrl'] = input.baseUrl.trim() || DEFAULT_BASE_URL
  }

  if (input.apiKey !== undefined) {
    if (input.apiKey === null || input.apiKey.trim() === '') {
      Object.assign(data, {
        apiKeyCiphertext: null,
        apiKeyIv: null,
        apiKeyDekCiphertext: null,
        apiKeyAad: null,
        apiKeyKeyVersion: null,
        apiKeyLast4: null,
      })
    } else {
      const key = input.apiKey.trim()
      const env = await wrapSecret('apiKey', key)
      Object.assign(data, {
        apiKeyCiphertext: env.ciphertext,
        apiKeyIv: env.iv,
        apiKeyDekCiphertext: env.dekCiphertext,
        apiKeyAad: env.aad,
        apiKeyKeyVersion: env.keyVersion,
        apiKeyLast4: key.slice(-4),
      })
      Object.assign(create, data)
    }
  }

  if (input.webhookSecret !== undefined) {
    if (input.webhookSecret === null || input.webhookSecret.trim() === '') {
      Object.assign(data, {
        webhookSecretCiphertext: null,
        webhookSecretIv: null,
        webhookSecretDekCiphertext: null,
        webhookSecretAad: null,
        webhookSecretKeyVersion: null,
      })
    } else {
      const env = await wrapSecret('webhookSecret', input.webhookSecret.trim())
      Object.assign(data, {
        webhookSecretCiphertext: env.ciphertext,
        webhookSecretIv: env.iv,
        webhookSecretDekCiphertext: env.dekCiphertext,
        webhookSecretAad: env.aad,
        webhookSecretKeyVersion: env.keyVersion,
      })
      Object.assign(create, data)
    }
  }

  await db.invoicingSetting.upsert({
    where: { id: SETTING_ID },
    create: { ...create, ...data },
    update: data,
  })

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'invoicing.config_updated',
    target: { type: 'InvoicingSetting', id: SETTING_ID },
    requestId: input.requestId,
    after: {
      baseUrlChanged: input.baseUrl !== undefined,
      apiKeyChanged: input.apiKey !== undefined,
      webhookSecretChanged: input.webhookSecret !== undefined,
    },
  })
}

/** Persist the events-feed cursor after a reconcile batch. */
export async function saveEventsCursor(cursor: string): Promise<void> {
  await db.invoicingSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, eventsCursor: cursor },
    update: { eventsCursor: cursor },
  })
}

/** Persist the highest SSE stream id processed. */
export async function saveStreamCursor(cursor: string): Promise<void> {
  await db.invoicingSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, streamCursor: cursor },
    update: { streamCursor: cursor },
  })
}
