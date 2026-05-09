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

export interface SendEmailInput {
  to: string | string[]
  subject: string
  /** Plaintext body. HTML is not used by the system-email paths today. */
  body: string
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
  const from = input.from ?? process.env['RESEND_FROM_ADDRESS'] ?? 'crm@studymind.co.uk'

  const fetchImpl = input.fetchImpl ?? safeFetch
  const res = await fetchImpl(RESEND_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: Array.isArray(input.to) ? input.to : [input.to],
      subject: input.subject,
      text: input.body,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ResendApiError(res.status, body)
  }
  const json = (await res.json().catch(() => ({}))) as { id?: string }
  return { status: 'sent', id: json.id ?? null }
}
