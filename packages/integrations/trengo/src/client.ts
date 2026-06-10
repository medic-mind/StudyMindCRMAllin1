// Trengo HTTP client.
//
// Per CLAUDE.md §11 each agent uses their OWN Trengo API token so outbound
// messages preserve agent identity. Tokens are KMS-encrypted at rest and
// decrypted just-in-time inside this factory. Expired tokens fail closed
// with BusinessError('TOKEN_EXPIRED'); we never fall back to a shared
// service token — that would break attribution.

import { BusinessError } from '@studymind/core'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { decryptField } from '@studymind/core/safeguarding'
import { db } from '@studymind/db'

export const TRENGO_API_BASE = 'https://app.trengo.com/api/v2' as const

export interface TrengoSendMessageInput {
  ticketId: number
  body: string
  channel: 'whatsapp' | 'sms' | 'email' | 'web_chat'
  /** Custom-field metadata that lets us reconcile Trengo events to our
   *  Interaction id. CLAUDE.md §11. */
  customFields?: Record<string, string>
  /** Trengo media ids to attach (uploaded first via `uploadMedia`). */
  attachmentIds?: number[]
}

export interface TrengoMediaResource {
  id: number
}

/** A file to upload to Trengo before attaching to a message. */
export interface TrengoUploadInput {
  filename: string
  contentType: string
  data: Buffer
}

/** Start a brand-new conversation (first outbound to a contact). */
export interface TrengoCreateConversationInput {
  channel: 'whatsapp' | 'sms' | 'email' | 'web_chat'
  /** E.164 phone for whatsapp/sms; email address for email. */
  recipient: string
  body: string
  customFields?: Record<string, string>
}

export interface TrengoCreateConversationResult {
  ticketId: number
  messageId: number | null
}

export interface TrengoMessageResource {
  id: number
  ticket_id: number
  body: string
  direction: 'outbound'
}

export interface TrengoTicketResource {
  id: number
  status: string
}

export interface TrengoLabelResource {
  id: number
  name: string
  color?: string | null
}

/** An approved WhatsApp (HSM) template as Trengo returns it. Field names vary
 *  slightly across Trengo plans/versions, so everything but `id` is optional
 *  and the outbound layer normalises. */
export interface TrengoWaTemplateResource {
  id: number
  title?: string | null
  name?: string | null
  message?: string | null
  body?: string | null
  content?: string | null
  status?: string | null
}

/** Send an approved WhatsApp template (HSM) — starts/refreshes the WhatsApp
 *  session so it works outside the 24-hour customer-service window. */
export interface TrengoSendWaTemplateInput {
  /** E.164 recipient phone. */
  recipientPhone: string
  /** The wa_templates row id (hsm_id). */
  templateId: number
  /** Values for the template's {{n}} placeholders, in order. */
  params: Array<{ key: string; value: string }>
}

export interface TrengoSendWaTemplateResult {
  ticketId: number | null
  messageId: number | null
}

export interface TrengoClient {
  readonly baseUrl: string
  readonly agentId: string
  sendMessage(input: TrengoSendMessageInput): Promise<TrengoMessageResource>
  assignTicket(ticketId: number, assigneeUserId: number): Promise<TrengoTicketResource>
  closeTicket(ticketId: number): Promise<TrengoTicketResource>
  reopenTicket(ticketId: number): Promise<TrengoTicketResource>
  /** Label (tag) catalogue + per-ticket attach/detach. CLAUDE.md §11. */
  listLabels(): Promise<TrengoLabelResource[]>
  createLabel(name: string): Promise<TrengoLabelResource>
  attachLabel(ticketId: number, labelId: number): Promise<void>
  detachLabel(ticketId: number, labelId: number): Promise<void>
  /** Internal (team-only) note on a ticket — never sent to the customer. */
  addInternalNote(ticketId: number, body: string): Promise<{ id: number }>
  /** Upload a file to Trengo, returning the media id to attach to a message. */
  uploadMedia(input: TrengoUploadInput): Promise<TrengoMediaResource>
  /** Start a brand-new conversation (create a ticket + send the first
   *  outbound message). CLAUDE.md §11. */
  createConversation(
    input: TrengoCreateConversationInput,
  ): Promise<TrengoCreateConversationResult>
  /** The workspace's approved WhatsApp (HSM) templates. */
  listWaTemplates(): Promise<TrengoWaTemplateResource[]>
  /** Send an approved WhatsApp template via /wa_sessions (valid outside the
   *  24-hour window — the same thing the Trengo UI does). */
  sendWaTemplate(input: TrengoSendWaTemplateInput): Promise<TrengoSendWaTemplateResult>
  request<T>(method: string, path: string, body?: unknown): Promise<T>
}

export class TrengoApiError extends Error {
  override readonly name = 'TrengoApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Trengo ${status} on ${path}`)
  }
}

export interface CreateTrengoClientOptions {
  agentId: string
  /** Optional override for tests. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Override the looked-up token for tests. Production callers omit this. */
  token?: string
  /** Audit/correlation context for the decryption call. */
  purpose?: string
  requestId?: string
}

/**
 * Build a Trengo client scoped to a single agent. The agent's token is
 * decrypted once at construction time. The returned client is therefore
 * tied to one agent and one request — it MUST NOT be cached across users.
 */
export async function createClientForAgent(
  opts: CreateTrengoClientOptions,
): Promise<TrengoClient> {
  const baseUrl = opts.baseUrl ?? TRENGO_API_BASE
  const fetchImpl = opts.fetchImpl ?? safeFetch

  let token = opts.token
  if (!token) {
    const row = await db.trengoToken.findUnique({
      where: { agentId: opts.agentId },
      select: {
        tokenCiphertext: true,
        tokenIv: true,
        dekCiphertext: true,
        aad: true,
        keyVersion: true,
        expiresAt: true,
        deletedAt: true,
      },
    })
    if (!row || row.deletedAt) {
      throw new BusinessError('TOKEN_EXPIRED', 'No Trengo token registered for agent', {
        agentId: opts.agentId,
      })
    }
    if (row.expiresAt.getTime() < Date.now()) {
      // CLAUDE.md §11: fail closed; never fall back to a shared token.
      throw new BusinessError('TOKEN_EXPIRED', 'Trengo token has expired for agent', {
        agentId: opts.agentId,
        expiresAt: row.expiresAt.toISOString(),
      })
    }
    token = await decryptField(
      {
        ciphertext: row.tokenCiphertext,
        iv: row.tokenIv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      {
        actorId: opts.agentId,
        purpose: opts.purpose ?? 'trengo.outbound',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      },
    )
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const parsed = text ? (JSON.parse(text) as unknown) : null
    if (!res.ok) {
      throw new TrengoApiError(res.status, path, parsed)
    }
    return parsed as T
  }

  return {
    baseUrl,
    agentId: opts.agentId,
    request,
    async sendMessage(input) {
      const res = await request<{ message: TrengoMessageResource }>(
        'POST',
        `/tickets/${input.ticketId}/messages`,
        {
          body: input.body,
          channel: input.channel,
          custom_fields: input.customFields ?? {},
          ...(input.attachmentIds && input.attachmentIds.length > 0
            ? { attachment_ids: input.attachmentIds }
            : {}),
        },
      )
      return res.message
    },
    async assignTicket(ticketId, assigneeUserId) {
      const res = await request<{ ticket: TrengoTicketResource }>(
        'PATCH',
        `/tickets/${ticketId}/assign`,
        { user_id: assigneeUserId },
      )
      return res.ticket
    },
    async closeTicket(ticketId) {
      const res = await request<{ ticket: TrengoTicketResource }>(
        'PATCH',
        `/tickets/${ticketId}/close`,
      )
      return res.ticket
    },
    async reopenTicket(ticketId) {
      const res = await request<{ ticket: TrengoTicketResource }>(
        'PATCH',
        `/tickets/${ticketId}/reopen`,
      )
      return res.ticket
    },
    async listLabels() {
      // Trengo paginates labels; one page (default) is plenty for an ops
      // team's tag catalogue. The response wraps rows under `data`.
      const res = await request<{ data?: TrengoLabelResource[] }>('GET', '/labels')
      return res.data ?? []
    },
    async createLabel(name) {
      const res = await request<
        { data?: TrengoLabelResource } & Partial<TrengoLabelResource>
      >('POST', '/labels', { name })
      const row = res.data ?? (res as TrengoLabelResource)
      return { id: row.id, name: row.name, color: row.color ?? null }
    },
    async attachLabel(ticketId, labelId) {
      await request('POST', `/tickets/${ticketId}/labels`, { label_id: labelId })
    },
    async detachLabel(ticketId, labelId) {
      await request('DELETE', `/tickets/${ticketId}/labels/${labelId}`)
    },
    async addInternalNote(ticketId, body) {
      // Internal notes are team-only — they are NOT delivered to the
      // customer. Trengo exposes them under the ticket /notes collection.
      const res = await request<{ data?: { id: number }; id?: number }>(
        'POST',
        `/tickets/${ticketId}/notes`,
        { body },
      )
      return { id: res.data?.id ?? res.id ?? 0 }
    },
    async uploadMedia(input) {
      // Multipart upload — we drive fetch directly (not `request`, which is
      // JSON) so the boundary header is set automatically. Trengo returns the
      // created media under `data` (or at the top level on some versions).
      const form = new FormData()
      // Buffer is a Uint8Array, but TS's BlobPart union trips on the
      // SharedArrayBuffer case — cast through BlobPart.
      const blob = new Blob([input.data as unknown as BlobPart], {
        type: input.contentType,
      })
      form.append('file', blob, input.filename)
      const res = await fetchImpl(`${baseUrl}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body: form,
      })
      const text = await res.text()
      const parsed = text ? (JSON.parse(text) as unknown) : null
      if (!res.ok) throw new TrengoApiError(res.status, '/media', parsed)
      const row = (parsed as { data?: TrengoMediaResource } & Partial<TrengoMediaResource>)
      const media = row.data ?? (row as TrengoMediaResource)
      return { id: media.id }
    },
    async createConversation(input) {
      // Start a new conversation. Trengo creates the ticket implicitly when a
      // first outbound message is sent to a recipient on a channel. The exact
      // payload shape varies by Trengo plan/version — kept here so a fix is a
      // one-line change. We embed our custom_fields for echo reconciliation.
      const res = await request<{
        ticket?: { id: number }
        message?: { id: number; ticket_id?: number }
        data?: { ticket_id?: number; id?: number }
      }>('POST', '/messages', {
        channel: input.channel,
        recipient: input.recipient,
        body: input.body,
        custom_fields: input.customFields ?? {},
      })
      const ticketId =
        res.ticket?.id ?? res.message?.ticket_id ?? res.data?.ticket_id ?? 0
      const messageId = res.message?.id ?? res.data?.id ?? null
      return { ticketId, messageId }
    },
    async listWaTemplates() {
      // Trengo paginates; one page covers an ops team's approved templates.
      // Rows come wrapped under `data`.
      const res = await request<{ data?: TrengoWaTemplateResource[] }>(
        'GET',
        '/wa_templates',
      )
      return res.data ?? []
    },
    async sendWaTemplate(input) {
      // POST /wa_sessions starts (or refreshes) a WhatsApp session with an
      // approved HSM template — the only way to message outside the 24-hour
      // window. Params are keyed "{{1}}", "{{2}}", … exactly as Trengo's own
      // composer sends them. Response shape varies by version; parse
      // defensively like createConversation.
      const res = await request<{
        ticket?: { id: number }
        message?: { id: number; ticket_id?: number }
        data?: { ticket_id?: number; id?: number }
      }>('POST', '/wa_sessions', {
        recipient_phone_number: input.recipientPhone,
        hsm_id: input.templateId,
        params: input.params.map((p) => ({ key: p.key, value: p.value })),
      })
      const ticketId =
        res.ticket?.id ?? res.message?.ticket_id ?? res.data?.ticket_id ?? null
      const messageId = res.message?.id ?? res.data?.id ?? null
      return { ticketId, messageId }
    },
  }
}
