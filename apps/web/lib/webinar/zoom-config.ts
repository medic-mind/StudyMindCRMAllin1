// Zoom credential storage + resolution (ADR 0035 amendment). The operator
// pastes a Server-to-Server OAuth app's Account ID / Client ID / Client Secret
// into Webinars → Settings; the secret is envelope-encrypted at rest (§21,
// mirroring packages/integrations/invoicing/src/config.ts). Every Zoom caller
// resolves credentials through `loadZoomConfig` — Settings row first, ZOOM_*
// env vars as the fallback so a Railway-only deploy keeps working. Plaintext
// secrets never reach logs or the UI (status exposes a masked account id only).

import { createCipheriv, randomBytes } from 'node:crypto'

import { writeAuditLogEntry } from '@studymind/audit'
import { decryptField, generateDataKey, KEY_VERSION } from '@studymind/core/safeguarding'
import type { PrismaClient } from '@prisma/client'
import { readZoomConfig, type ZoomConfig } from '@studymind/integration-zoom'

const SETTINGS_ID = 'webinar' as const
const SECRET_FIELD = 'zoomClientSecret' as const

async function wrapSecret(plaintext: string): Promise<{
  ciphertext: Buffer
  iv: Buffer
  dekCiphertext: Buffer
  aad: Buffer
  keyVersion: number
}> {
  const { plaintext: dekPlain, ciphertext: dekCiphertext } = await generateDataKey()
  const iv = randomBytes(12)
  const aad = Buffer.from(`WebinarSettings|${SETTINGS_ID}|${SECRET_FIELD}|${KEY_VERSION}`, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', dekPlain, iv)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  dekPlain.fill(0)
  return { ciphertext: Buffer.concat([enc, tag]), iv, dekCiphertext, aad, keyVersion: KEY_VERSION }
}

/**
 * The effective Zoom credentials: the Settings row when fully configured,
 * else the ZOOM_* env vars, else null (callers fail closed — the whole Zoom
 * feature is off).
 */
export async function loadZoomConfig(db: PrismaClient): Promise<ZoomConfig | null> {
  const row = await db.webinarSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: {
      zoomAccountId: true,
      zoomClientId: true,
      zoomClientSecretCiphertext: true,
      zoomClientSecretIv: true,
      zoomClientSecretDekCiphertext: true,
      zoomClientSecretAad: true,
      zoomClientSecretKeyVersion: true,
    },
  })
  if (
    row?.zoomAccountId &&
    row.zoomClientId &&
    row.zoomClientSecretCiphertext &&
    row.zoomClientSecretIv &&
    row.zoomClientSecretDekCiphertext &&
    row.zoomClientSecretAad &&
    row.zoomClientSecretKeyVersion !== null
  ) {
    const clientSecret = await decryptField(
      {
        ciphertext: row.zoomClientSecretCiphertext,
        iv: row.zoomClientSecretIv,
        dekCiphertext: row.zoomClientSecretDekCiphertext,
        aad: row.zoomClientSecretAad,
        keyVersion: row.zoomClientSecretKeyVersion,
      },
      { actorId: null, purpose: 'webinar.zoom_api' },
    )
    return { accountId: row.zoomAccountId, clientId: row.zoomClientId, clientSecret }
  }
  return readZoomConfig()
}

export interface ZoomConnectionStatus {
  configured: boolean
  /** Where the working credentials come from. */
  source: 'settings' | 'env' | null
  /** e.g. "Abc1…Xyz" — enough to recognise the account, never the secret. */
  accountIdMasked: string | null
}

function mask(v: string): string {
  return v.length <= 8 ? `${v.slice(0, 2)}…` : `${v.slice(0, 4)}…${v.slice(-3)}`
}

export async function zoomConnectionStatus(db: PrismaClient): Promise<ZoomConnectionStatus> {
  const row = await db.webinarSettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { zoomAccountId: true, zoomClientId: true, zoomClientSecretCiphertext: true },
  })
  if (row?.zoomAccountId && row.zoomClientId && row.zoomClientSecretCiphertext) {
    return { configured: true, source: 'settings', accountIdMasked: mask(row.zoomAccountId) }
  }
  const env = readZoomConfig()
  if (env) return { configured: true, source: 'env', accountIdMasked: mask(env.accountId) }
  return { configured: false, source: null, accountIdMasked: null }
}

/** Store pasted credentials (encrypting the secret). The row is created if the
 *  operator has never saved webinar settings. Audited. */
export async function saveZoomCredentials(
  db: PrismaClient,
  input: { accountId: string; clientId: string; clientSecret: string },
  ctx: { actorId: string; requestId: string },
): Promise<void> {
  const wrapped = await wrapSecret(input.clientSecret)
  const data = {
    zoomAccountId: input.accountId,
    zoomClientId: input.clientId,
    zoomClientSecretCiphertext: wrapped.ciphertext,
    zoomClientSecretIv: wrapped.iv,
    zoomClientSecretDekCiphertext: wrapped.dekCiphertext,
    zoomClientSecretAad: wrapped.aad,
    zoomClientSecretKeyVersion: wrapped.keyVersion,
  }
  await db.webinarSettings.upsert({
    where: { id: SETTINGS_ID },
    update: data,
    // Sensible template defaults on first save — same shape settings.update
    // uses; the operator edits them later.
    create: {
      id: SETTINGS_ID,
      emailSubjectTemplate: '',
      emailBodyTemplate: '',
      ...data,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'webinar.zoom_connected',
    target: { type: 'WebinarSettings', id: SETTINGS_ID },
    after: { accountId: mask(input.accountId) },
  })
}

/** Remove the stored credentials (env fallback, if any, still applies). */
export async function clearZoomCredentials(
  db: PrismaClient,
  ctx: { actorId: string; requestId: string },
): Promise<void> {
  await db.webinarSettings.updateMany({
    where: { id: SETTINGS_ID },
    data: {
      zoomAccountId: null,
      zoomClientId: null,
      zoomClientSecretCiphertext: null,
      zoomClientSecretIv: null,
      zoomClientSecretDekCiphertext: null,
      zoomClientSecretAad: null,
      zoomClientSecretKeyVersion: null,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    requestId: ctx.requestId,
    action: 'webinar.zoom_disconnected',
    target: { type: 'WebinarSettings', id: SETTINGS_ID },
    after: null,
  })
}
