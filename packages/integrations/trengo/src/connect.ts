// Trengo per-agent token connect/reconnect helper. CLAUDE.md §11.
//
// Each agent's outbound goes through their OWN Trengo API token (never a
// shared service token — that would break agent attribution). Tokens rotate
// every 90 days; this helper validates a freshly-pasted token by calling
// Trengo `/me`, KMS-envelope-encrypts the secret, and upserts the
// TrengoToken row keyed on `agentId`.

import { createCipheriv, randomBytes } from 'node:crypto'

import { writeAuditLogEntry } from '@studymind/audit'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { generateDataKey, KEY_VERSION } from '@studymind/core/safeguarding'
import { db } from '@studymind/db'

import { TRENGO_API_BASE } from './client'

export const TRENGO_TOKEN_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

export interface ConnectTrengoTokenInput {
  agentId: string
  token: string
  requestId: string
  /** Override the fetch (tests). */
  fetchImpl?: typeof fetch
}

export interface ConnectTrengoTokenResult {
  agentId: string
  expiresAt: Date
  trengoUserId?: number | undefined
  trengoEmail?: string | undefined
}

export class TrengoTokenInvalidError extends Error {
  override readonly name = 'TrengoTokenInvalidError'
  constructor(public readonly status: number) {
    super(`Trengo rejected the token (HTTP ${status}). Generate a new one.`)
  }
}

interface TrengoMeResponse {
  data?: { id?: number; email?: string }
  id?: number
  email?: string
}

/**
 * Validate a freshly-pasted Trengo token by calling `/me`, then encrypt and
 * persist it. Returns the new expiry. On invalid token: throws
 * `TrengoTokenInvalidError` and writes nothing.
 */
export async function connectTrengoToken(
  input: ConnectTrengoTokenInput,
): Promise<ConnectTrengoTokenResult> {
  const fetchImpl = input.fetchImpl ?? safeFetch

  // 1. Validate by calling /me. A 401/403 means the token is wrong; a 5xx
  //    means Trengo is degraded — we surface that distinctly so the agent
  //    can retry without re-pasting.
  const res = await fetchImpl(`${TRENGO_API_BASE}/me`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.token}`,
      Accept: 'application/json',
    },
  })
  if (res.status === 401 || res.status === 403) {
    throw new TrengoTokenInvalidError(res.status)
  }
  if (!res.ok) {
    throw new Error(`Trengo /me returned ${res.status}; try again later`)
  }
  const text = await res.text()
  const parsed: TrengoMeResponse = text ? (JSON.parse(text) as TrengoMeResponse) : {}
  const trengoUserId = parsed.data?.id ?? parsed.id
  const trengoEmail = parsed.data?.email ?? parsed.email

  // 2. Envelope-encrypt the token. Mirrors packages/core/safeguarding/
  //    encrypt.ts but persists into the existing TrengoToken columns rather
  //    than EncryptedField (the model pre-dates the EncryptedField pattern).
  //    generateDataKey() uses KMS when configured, else a local key.
  const { plaintext: dekPlain, ciphertext: dekCiphertext } = await generateDataKey()
  const iv = randomBytes(12)
  const aad = Buffer.from(`User|${input.agentId}|trengo.api_token|${KEY_VERSION}`, 'utf8')
  const cipher = createCipheriv('aes-256-gcm', dekPlain, iv)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(input.token, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const ciphertext = Buffer.concat([enc, tag])
  dekPlain.fill(0)

  const expiresAt = new Date(Date.now() + TRENGO_TOKEN_LIFETIME_MS)

  // 3. Upsert keyed on agentId.
  await db.trengoToken.upsert({
    where: { agentId: input.agentId },
    create: {
      agentId: input.agentId,
      tokenCiphertext: ciphertext,
      tokenIv: iv,
      dekCiphertext,
      aad,
      keyVersion: KEY_VERSION,
      expiresAt,
      createdById: input.agentId,
      updatedById: input.agentId,
    },
    update: {
      tokenCiphertext: ciphertext,
      tokenIv: iv,
      dekCiphertext,
      aad,
      keyVersion: KEY_VERSION,
      expiresAt,
      deletedAt: null,
      updatedById: input.agentId,
    },
  })

  // ADR 0020 Phase 6 — stamp the user's Trengo numeric id so the webhook
  // can map `assignee_id` events to a CRM User. Best-effort: a `/me` that
  // does not return an id is a Trengo quirk, not an auth failure — we keep
  // the token registered and skip the mapping.
  if (typeof trengoUserId === 'number') {
    await db.user.update({
      where: { id: input.agentId },
      data: { trengoUserId },
    })
  }

  await writeAuditLogEntry(db, {
    actorId: input.agentId,
    action: 'trengo.token_connected',
    target: { type: 'User', id: input.agentId },
    requestId: input.requestId,
    after: {
      expiresAt: expiresAt.toISOString(),
      trengoUserId: trengoUserId ?? null,
    },
  })

  return {
    agentId: input.agentId,
    expiresAt,
    trengoUserId: trengoUserId ?? undefined,
    trengoEmail: trengoEmail ?? undefined,
  }
}
