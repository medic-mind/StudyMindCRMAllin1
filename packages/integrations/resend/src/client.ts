// Minimal Resend transactional email client. CLAUDE.md §3, §21.1.
//
// We use Resend for SYSTEM email (DSL break-glass alerts to the DPO,
// outage notifications), not for Gmail-synced family comms — those go
// through Gmail per CLAUDE.md §14.
//
// Auth via RESEND_API_KEY. Outbound via safeFetch.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

export const RESEND_API_URL = 'https://api.resend.com/emails' as const

export class ResendApiError extends Error {
  override readonly name = 'ResendApiError'
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Resend API ${status}: ${body}`)
  }
}

/**
 * A file to attach to an outbound email. `content` is the raw bytes
 * base64-encoded — Resend's documented attachment shape. Used by the user
 * welcome / password-reset flows to carry the credentials PDF (ADR 0021).
 */
export interface SendEmailAttachment {
  filename: string
  /** Base64-encoded file bytes. */
  content: string
  /** Optional MIME type, e.g. 'application/pdf'. */
  contentType?: string
}

export interface SendEmailInput {
  to: string | string[]
  subject: string
  /** Plaintext body. Always set so every message has a text/plain part. */
  body: string
  /** Optional HTML body. When present Resend renders this and keeps `body` as the text fallback. */
  html?: string
  /** Optional file attachments (e.g. the welcome-credentials PDF). */
  attachments?: SendEmailAttachment[]
  /** From override. Defaults to RESEND_FROM_ADDRESS. */
  from?: string
  /** Test seam. */
  fetchImpl?: typeof fetch
  /** API key override; defaults to RESEND_API_KEY. */
  apiKey?: string
}

export interface SendEmailResult {
  status: 'sent' | 'skipped'
  /** Resend message id when sent; null when skipped. */
  id: string | null
}

/**
 * Send a system email. Returns `skipped` when no API key is configured —
 * callers do not need to special-case that.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = input.apiKey ?? process.env['RESEND_API_KEY']
  if (!apiKey) return { status: 'skipped', id: null }
  const from =
    input.from ?? process.env['RESEND_FROM_ADDRESS'] ?? 'StudyMind CRM <info@studymind.co.uk>'

  // Resend accepts `text` and/or `html`, plus an optional `attachments` array
  // of { filename, content (base64) }. We only include the optional keys when
  // present so the existing plaintext-only callers are unaffected.
  const payload: Record<string, unknown> = {
    from,
    to: Array.isArray(input.to) ? input.to : [input.to],
    subject: input.subject,
    text: input.body,
  }
  if (input.html) payload['html'] = input.html
  if (input.attachments && input.attachments.length > 0) {
    payload['attachments'] = input.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType ? { content_type: a.contentType } : {}),
    }))
  }

  const fetchImpl = input.fetchImpl ?? safeFetch
  const res = await fetchImpl(RESEND_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ResendApiError(res.status, body)
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return { status: 'sent', id: json.id ?? null }
}
